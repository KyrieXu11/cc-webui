#!/usr/bin/env python3
"""Real installed CLI + actual WebUI app-server executor, localhost fixtures only.

No real models, credentials, browser automation or global config changes.
Add --inherited-review to verify CLI Auto-review for an inherited MCP too.
Add --resume-check to verify metadata-only resume still restores model context.
Add --retry-check to simulate one dropped stream and verify native retry status.
The child sandbox denies outbound non-loopback traffic and the real home,
except reading this repository. Requires macOS sandbox-exec and Node/tsx.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent
BIN = os.environ.get('CC_WEBUI_CODEX_BIN') or shutil.which('codex')
assert BIN
BIN = str(Path(BIN).resolve())
NODE = str(Path(shutil.which('node')).resolve())
REAL_HOME = Path.home().resolve()
CONFIG = REAL_HOME / '.codex/config.toml'
INHERITED_REVIEW = '--inherited-review' in sys.argv
RESUME_CHECK = '--resume-check' in sys.argv
RETRY_CHECK = '--retry-check' in sys.argv
before = hashlib.sha256(CONFIG.read_bytes()).hexdigest() if CONFIG.exists() else None
state = {'requests': [], 'main': 0, 'tools': 0}


def message(text):
    return {'type': 'message', 'id': 'msg_fixture', 'status': 'completed', 'role': 'assistant',
            'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, status=200):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == '/fixture-state':
            self.reply({'tools': state['tools']})
        else:
            self.reply({'data': []}, 405 if self.path == '/mcp' else 200)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
        if self.path == '/mcp':
            assert self.headers.get('Authorization') == 'Bearer FAKE_MCP_SECRET'
            if 'id' not in body:
                self.send_response(204)
                self.end_headers()
                return
            method = body.get('method')
            if method == 'initialize':
                result = {'protocolVersion': body['params']['protocolVersion'], 'capabilities': {'tools': {}},
                          'serverInfo': {'name': 'synthetic-pause', 'version': '1'}}
            elif method == 'tools/list':
                result = {'tools': [{'name': 'pause', 'description': 'Only pauses this local synthetic fixture',
                          'inputSchema': {'type': 'object', 'properties': {}},
                          # Force a review in the inherited fixture; these are
                          # synthetic hints, not a claim about a real risk.
                          'annotations': {'readOnlyHint': not INHERITED_REVIEW,
                                          'destructiveHint': INHERITED_REVIEW, 'openWorldHint': INHERITED_REVIEW}}]}
            elif method == 'tools/call':
                state['tools'] += 1
                time.sleep(0.8)
                result = {'content': [{'type': 'text', 'text': 'Synthetic pause completed'}]}
            else:
                result = {}
            self.reply({'jsonrpc': '2.0', 'id': body['id'], 'result': result})
            return
        assert self.path == '/v1/responses', self.path
        fmt = body.get('text', {}).get('format', {})
        reviewing = 'outcome' in fmt.get('schema', {}).get('properties', {})
        saw_steer = 'STEER_SENTINEL' in json.dumps(body.get('input', []))
        saw_initial = 'FIRST_SENTINEL' in json.dumps(body.get('input', []))
        saw_resume = 'RESUME_SENTINEL' in json.dumps(body.get('input', []))
        state['requests'].append({'reviewing': reviewing, 'saw_steer': saw_steer,
                                  'saw_initial': saw_initial, 'saw_resume': saw_resume,
                                  'model': body.get('model'), 'tier': body.get('service_tier')})
        if reviewing:
            output = [message(json.dumps({'outcome': 'allow', 'risk_level': 'low', 'user_authorization': 'high',
                                         'rationale': 'Only the authorized synthetic loopback pause tool.'}))]
        else:
            state['main'] += 1
            if RETRY_CHECK and state['main'] == 1:
                # End a genuine SSE connection before response.completed.
                # The installed CLI, not this script, must decide to retry it.
                event = {'type': 'response.created', 'response': {'id': 'resp_drop', 'object': 'response',
                         'status': 'in_progress', 'model': body['model'], 'output': []}}
                raw = ('event: response.created\ndata: ' + json.dumps(event) + '\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            if state['main'] == (2 if RETRY_CHECK else 1):
                output = [{'type': 'custom_tool_call', 'id': 'fc_pause', 'call_id': 'call_pause',
                           'namespace': 'functions', 'name': 'exec',
                           'input': 'text(await tools.mcp__fixture__pause({}));'}]
            else:
                text = ('RESUMED_CONTEXT_OK' if saw_initial and saw_steer else 'RESUME_CONTEXT_MISSING') if saw_resume else ('STEERED_OK' if saw_steer else 'STEER_MISSING')
                output = [message(text)]
        response = {'id': f'resp_{len(state["requests"])}', 'object': 'response', 'created_at': int(time.time()),
                    'status': 'completed', 'model': body['model'], 'output': output,
                    'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2,
                              'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}}}
        events = [{'type': 'response.output_item.done', 'output_index': 0, 'item': output[0]},
                  {'type': 'response.completed', 'response': response}]
        raw = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='cc-native-steer-') as temp:
        root = Path(temp)
        config = root / 'config.toml'
        config.write_text('model="gpt-6.1-sol"\nservice_tier="fast"\nmodel_provider="fixture"\n'
                          '[features]\nfast_mode=true\n'
                          '[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:' + str(server.server_port) + '/v1"\n'
                          'wire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n')
        if INHERITED_REVIEW:
            with config.open('a') as file:
                file.write('[mcp_servers.fixture]\nurl="http://127.0.0.1:' + str(server.server_port) +
                           '/mcp"\nbearer_token_env_var="FIXTURE_TOKEN"\ndefault_tools_approval_mode="prompt"\n')
        initial = config.read_bytes()
        env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'CODEX_HOME': str(root),
               'CC_WEBUI_CODEX_BIN': str(BIN), 'NO_PROXY': '127.0.0.1,localhost', 'DISABLE_TELEMETRY': '1',
               'FIXTURE_TOKEN': 'FAKE_MCP_SECRET'}
        mcp_servers = [] if INHERITED_REVIEW else [{'name': 'fixture',
                      'url': f'http://127.0.0.1:{server.server_port}/mcp', 'bearerToken': 'FAKE_MCP_SECRET'}]
        policy = ('(version 1)(allow default)(deny network-outbound)'
                  '(allow network-outbound (remote ip "localhost:*"))'
                  f'(deny file-read* file-write* (subpath {json.dumps(str(REAL_HOME))}))'
                  '(allow file-read-metadata)'
                  f'(allow file-read* (subpath {json.dumps(str(ROOT))}))'
                  f'(allow file-read* (literal {json.dumps(NODE)}))'
                  f'(allow file-read* (literal {json.dumps(BIN)}))')
        subprocess.run(['/usr/bin/sandbox-exec', '-p', policy, '/usr/bin/true'], check=True)
        code = f'''
import assert from 'node:assert/strict';
import {{codexAppServerExecutor}} from './server/executors/codex-app-server.ts';
let send=null,accepted=false,final='',nativeTurn,thread;const retries=[];
const opts={{cwd:{json.dumps(str(root))},prompt:'Use the local synthetic pause tool. FIRST_SENTINEL',
 model:'gpt-6.1-sol',mode:'auto',effort:'xhigh',disableNativeMemory:true,timeoutMs:30000,
 signal:new AbortController().signal,onSteer:s=>{{send=s}},
 mcpServers:{json.dumps(mcp_servers)}}};
for await(const f of codexAppServerExecutor.exec(opts)){{
 if(f.kind==='ended'){{assert.equal(f.result.status,'completed',f.result.error);thread=f.result.sessionHandle;continue}}
 const p=f.payload;
 if(p.type==='codex_retry')retries.push(p);
 if(p.type==='turn.started')nativeTurn=p.turn_id;
 if(p.type==='item.started'&&p.item.type==='mcp_tool_call'&&!accepted){{
   // Native item/started precedes Auto-review. Wait for the actual fixture
   // call, otherwise steering can cancel the pending approval before tools
   // run (a valid CLI behavior, but not the path this test is measuring).
   let tools=0;
   for(let i=0;i<250&&!tools;i++){{
     tools=(await (await fetch({json.dumps(f'http://127.0.0.1:{server.server_port}/fixture-state')})).json()).tools;
     if(!tools)await new Promise(r=>setTimeout(r,20));
   }}
   assert.equal(tools,1,'Synthetic tool must be executing before steering');
   assert.ok(send);accepted=await send('STEER_SENTINEL: change direction before completing.','q-real');assert.equal(accepted,true);
 }}
 if(p.item?.type==='agent_message')final=p.item.text;
}}
assert.ok(nativeTurn);assert.ok(accepted);assert.equal(final,'STEERED_OK');assert.equal(send,null);
if({str(RETRY_CHECK).lower()}){{
 assert.deepEqual(retries.map(r=>r.status),['retrying','resumed']);
 assert.ok(retries[0].message);assert.equal(retries[0].attempt,undefined);assert.equal(retries[0].retryDelayMs,undefined);
}}
let resumedFinal;
if({str(RESUME_CHECK).lower()}){{
 const frames=[];
 for await(const f of codexAppServerExecutor.exec({{...opts,resume:thread,prompt:'RESUME_SENTINEL: continue the same conversation.',signal:new AbortController().signal}})){{
   if(f.kind==='ended'){{assert.equal(f.result.status,'completed',f.result.error);assert.equal(f.result.sessionHandle,thread);continue}}
   const p=f.payload;frames.push(p);
   if(p.item?.type==='agent_message')resumedFinal=p.item.text;
 }}
 assert.equal(resumedFinal,'RESUMED_CONTEXT_OK','Metadata-only response must not drop the model context');
 assert.ok(!frames.some(f=>/Full-history hydration/.test(f.item?.message??'')),'Resume should not emit the hydration warning');
}}
console.log(JSON.stringify({{accepted,nativeTurn,final,resumedFinal,retries}}));
'''
        proc = subprocess.run(['/usr/bin/sandbox-exec', '-p', policy, NODE, '--import', 'tsx', '--input-type=module', '-e', code],
                              cwd=ROOT, env=env, text=True, capture_output=True, timeout=40)
        assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-3000:]
        assert state['tools'] == 1, json.dumps(state) + proc.stdout + proc.stderr[-2000:]
        assert state['main'] >= 2 and any(r['saw_steer'] for r in state['requests'] if not r['reviewing'])
        if INHERITED_REVIEW:
            assert any(r['reviewing'] for r in state['requests']), 'Inherited tool bypassed Auto-review'
        if RESUME_CHECK:
            assert any(r['saw_resume'] and r['saw_initial'] and r['saw_steer'] for r in state['requests']), 'Resumed request lost prior conversation'
        assert all(r['tier'] not in ['fast', 'priority', 'ultrafast'] for r in state['requests'])
        assert initial == config.read_bytes(), 'Local config was edited'
        after = hashlib.sha256(CONFIG.read_bytes()).hexdigest() if CONFIG.exists() else None
        assert before == after, 'Global config was edited'
        print(proc.stdout.strip())
        print(json.dumps({'inherited_review': INHERITED_REVIEW, 'resume_check': RESUME_CHECK, 'retry_check': RETRY_CHECK, 'real_model_calls': 0, 'synthetic_tool_calls': state['tools'],
                          'fixture_requests': state['requests'], 'global_config_unchanged': True}))
finally:
    server.shutdown()
    server.server_close()
