"""Optional real-CLI integration check (requires Node/tsx and Codex 0.162+).

python3 scripts/verify-codex-auto-review.py
Uses ONLY a localhost Responses fixture and a fake stdio Playwright server.
No actual model/browser calls, credentials, global config edits or user data.
"""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
BIN = os.environ.get("CC_WEBUI_CODEX_BIN") or shutil.which("codex")
assert BIN, "Install Codex CLI first"
GLOBAL_CONFIG = pathlib.Path.home() / ".codex/config.toml"
before = hashlib.sha256(GLOBAL_CONFIG.read_bytes()).hexdigest() if GLOBAL_CONFIG.exists() else None
print(subprocess.check_output([BIN, "--version"], text=True).strip())
state = {}


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        assert self.path == "/v1/responses", self.path
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        fmt = body.get("text", {}).get("format", {})
        reviewing = fmt.get("type") == "json_schema" and "outcome" in fmt.get("schema", {}).get("properties", {})
        state["requests"].append({"review": reviewing, "model": body["model"], "tier": body.get("service_tier")})
        if reviewing:
            text = json.dumps({"outcome": state["decision"], "risk_level": "low" if state["decision"] == "allow" else "high",
                               "user_authorization": "high", "rationale": "Synthetic local fixture decision."})
            if state["decision"] == "malformed":
                text = "{}"
            output = [self.message("review", text)]
        else:
            state["main_calls"] += 1
            if state["main_calls"] == 1:
                output = [{"type": "custom_tool_call", "id": "fc_" + state["label"], "call_id": "call_" + state["label"],
                           "namespace": "functions", "name": "exec",
                           "input": 'text(await tools.mcp__playwright__browser_navigate({url:"http://127.0.0.1/fixture.html"}));'}]
            else:
                output = [self.message("final", "Local fixture finished.")]
        response = {"id": "resp_" + str(len(state["requests"])), "object": "response", "created_at": int(time.time()),
                    "status": "completed", "model": body["model"], "output": output,
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
                              "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}
        events = [{"type": "response.output_item.done", "output_index": 0, "item": output[0]},
                  {"type": "response.completed", "response": response}]
        data = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    @staticmethod
    def message(name, text):
        return {"type": "message", "id": "msg_" + name, "status": "completed", "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}]}


server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
tmp = pathlib.Path(tempfile.mkdtemp(prefix="cc-codex-auto-review-"))
calls = tmp / "calls.jsonl"
fake = tmp / "mcp.py"
fake.write_text("""import sys,json,pathlib
marker=pathlib.Path(""" + repr(str(calls)) + """)
for line in sys.stdin:
 try:r=json.loads(line)
 except:continue
 if 'id' not in r:continue
 method=r.get('method'); result={}
 if method=='initialize':result={'protocolVersion':r['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif method=='tools/list':result={'tools':[{'name':'browser_navigate','description':'Only navigates the fake fixture','inputSchema':{'type':'object','properties':{'url':{'type':'string'}},'required':['url']},'annotations':{'readOnlyHint':False,'destructiveHint':True,'openWorldHint':True}}]}
 elif method=='tools/call':
  with marker.open('a') as f:f.write(json.dumps({'name':r['params']['name']})+'\\n')
  result={'content':[{'type':'text','text':'Fake navigation complete.'}]}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)
""")
config = tmp / "config.toml"
config.write_text('model="gpt-6.1-sol"\nservice_tier="fast"\nmodel_provider="fixture"\n'
                  '[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:' + str(server.server_port) + '/v1"\n'
                  'wire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n'
                  '[mcp_servers.playwright]\ncommand=' + json.dumps(sys.executable) + '\nargs=[' + json.dumps(str(fake)) + ']\n'
                  'default_tools_approval_mode="prompt"\n')
config_before = config.read_bytes()
env = {k: v for k, v in os.environ.items() if not any(x in k.upper() for x in ["API_KEY", "TOKEN", "AUTHORIZATION"])}
env.update(CODEX_HOME=str(tmp), NO_PROXY="127.0.0.1,localhost")


def run(label, mode, decision, resume=None):
    state.clear()
    state.update(label=label, decision=decision, main_calls=0, requests=[])
    calls.unlink(missing_ok=True)
    # Exercise the repository's ACTUAL argv builder, not a duplicate policy.
    opts = {"cwd": str(tmp), "mode": mode, "effort": "xhigh", "model": "gpt-6.1-sol", "prompt": "fixture", "resume": resume}
    code = 'import {buildCodexArgs} from "./server/executors/codex-executor.ts"; console.log(JSON.stringify(buildCodexArgs(JSON.parse(process.argv[1]))));'
    args = json.loads(subprocess.check_output(["node", "--import", "tsx", "--input-type=module", "-e", code, json.dumps(opts)], cwd=ROOT, text=True))
    proc = subprocess.run([BIN, *args], input="Inspect the fake local page via Playwright: http://127.0.0.1/fixture.html",
                          cwd=tmp, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45)
    assert proc.returncode == 0, proc.stderr[-1500:]
    frames = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    count = len(calls.read_text().splitlines()) if calls.exists() else 0
    reviews = sum(r["review"] for r in state["requests"])
    tools = [f["item"] for f in frames if f.get("type") == "item.completed" and f.get("item", {}).get("type") == "mcp_tool_call"]
    assert tools, "Real CLI did not reach the fake MCP tool"
    assert all(r["tier"] not in ["priority", "fast", "ultrafast"] for r in state["requests"]), "Fast tier was restored"
    assert count == (1 if mode == "auto" and decision == "allow" else 0), "Unexpected tool execution"
    if mode == "auto":
        assert reviews > 0, "Tool bypassed the automatic reviewer"
    else:
        assert reviews == 0, "Strict/non-Auto mode must not enable review or expansion"
    assert tools[-1]["status"] == ("completed" if count else "failed")
    if decision == "malformed":
        assert "Automatic approval review failed" in tools[-1]["error"]["message"]
    if decision == "deny":
        message = tools[-1]["error"]["message"].lower()
        assert any(word in message for word in ["denied", "reject", "declin"]), message
    thread = next((f.get("thread_id") for f in frames if f.get("type") == "thread.started"), resume)
    root_file = next(tmp.glob("sessions/**/*" + thread + ".jsonl"))
    context = [json.loads(line)["payload"] for line in root_file.read_text().splitlines()
               if json.loads(line).get("type") == "turn_context"][-1]
    assert context["approval_policy"] == ("on-request" if mode == "auto" else "never")
    assert context["approvals_reviewer"] == ("auto_review" if mode == "auto" else "user")
    print(json.dumps({"case": label, "reviews": reviews, "tool_calls": count, "status": tools[-1]["status"], "no_fast": True}))
    return thread


try:
    legacy = run("legacy-never", "default", "allow")
    run("resume-auto-allow", "auto", "allow", legacy)
    run("fresh-auto-allow", "auto", "allow")
    run("auto-deny", "auto", "deny")
    run("review-malformed", "auto", "malformed")
    run("plan-never", "plan", "allow")
    assert config.read_bytes() == config_before
    if before:
        assert hashlib.sha256(GLOBAL_CONFIG.read_bytes()).hexdigest() == before
    print("Verified real-CLI review routing/fail-closed behavior with fixtures only; global config unchanged.")
finally:
    server.shutdown()
    server.server_close()
    shutil.rmtree(tmp)
