#!/usr/bin/env python3
"""Capture Claude Code 2.1.283 native background memory requests.

macOS only. Uses isolated HOME/config/workspaces, dummy credentials and a
loopback fake API. The child sandbox denies outbound non-loopback networking
and access to the real home, except reading the verified binary.

Synthetic GrowthBook caches enable individual native branches for observation.
The desktop entrypoint is only a probe fixture, not a production integration
recommendation. Main fake replies are delayed to let lazy housekeeping start;
stream-json stdin stays open while native background tasks finish.

Full requests contain vendor system prompts and must stay in private research
storage. Project only memory-related user prompts with the paired verifier."""
import argparse
import hashlib
import json
import os
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
DUMMY = 'sk-ant-local-fake-memory-maintenance-only'
HASH = 'd8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e'

def blocks(body):
    for msg in body.get('messages', []):
        c = msg.get('content', [])
        if isinstance(c, str):
            yield c
        elif isinstance(c, list):
            for b in c:
                if b.get('type') == 'text':
                    yield b.get('text', '')

def main(binary, out, selected):
    binary = binary.resolve()
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == HASH, 'Unexpected binary: re-evaluate the versioned baseline first'
    real_home = Path.home().resolve()
    out.mkdir(mode=0o700, exist_ok=False)
    current = {}
    requests = []
    results = []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):

        def log_message(self, *_a):
            pass

        def reply(self, obj, status=200):
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply({'data': [{'id': 'claude-sonnet-4-6', 'type': 'model', 'display_name': 'Synthetic model'}], 'has_more': False})

        def do_POST(self):
            is_messages = '/messages' in self.path and (not self.path.endswith('/count_tokens'))
            if '/messages' in self.path:
                k = self.headers.get('x-api-key')
                a = self.headers.get('authorization')
                if not (k == DUMMY and a is None or (k is None and a == 'Bearer ' + DUMMY)):
                    self.reply({'error': 'unexpected auth rejected; no credentials logged'}, 401)
                    return
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
            if not is_messages:
                self.reply({'input_tokens': 128} if self.path.endswith('/count_tokens') else {})
                return
            texts = list(blocks(body))
            phase = 'extract' if any(('You are now acting as the memory extraction subagent.' in t for t in texts)) else 'dream' if any(('# Dream: Memory Consolidation' in t for t in texts)) else 'title' if any((t.startswith('<session>\n') for t in texts)) else 'main'
            with lock:
                n = current.setdefault('counts', {}).get(phase, 0)
                current['counts'][phase] = n + 1
                rec = {'case': current['name'], 'phase': phase, 'phase_request': n + 1, 'dummy_auth_verified': True, 'body': body}
                requests.append(rec)
                f = out / f'request-{len(requests):03d}.json'
                f.write_text(json.dumps(rec, ensure_ascii=False, indent=2))
                f.chmod(0o600)
            if phase == 'main' and current.get('slow_main'):
                time.sleep(0.5)
            content = [{'type': 'text', 'text': 'Nothing to save.' if phase != 'main' else 'probe-ok'}]
            if phase == 'main' and n == 0 and (current.get('action') == 'stale'):
                content = [{'type': 'tool_use', 'id': 'tool_main_read', 'name': 'Read', 'input': {'file_path': str(current['memory'] / 'probe-topic.md')}}]
            if phase == 'main' and n == 0 and (current.get('action') == 'write'):
                content = [{'type': 'tool_use', 'id': 'tool_main_write', 'name': 'Write', 'input': {'file_path': str(current['memory'] / 'probe-topic.md'), 'content': '---\nname: probe-topic\ndescription: Synthetic preference\nmetadata:\n  type: feedback\n---\nPROBE_UPDATED_BY_MAIN\n'}}]
            if phase == 'main' and n == 0 and (current.get('action') == 'failed_edit'):
                content = [{'type': 'tool_use', 'id': 'tool_main_failed', 'name': 'Edit', 'input': {'file_path': str(current['memory'] / 'probe-topic.md'), 'old_string': 'PROBE_STRING_NOT_PRESENT', 'new_string': 'PROBE_NEW'}}]
            if phase in ('extract', 'dream') and current.get('action') in ('update', 'stale') and (n == 0):
                content = [{'type': 'tool_use', 'id': 'tool_bg_read', 'name': 'Read', 'input': {'file_path': str(current['memory'] / 'probe-topic.md')}}]
            if phase in ('extract', 'dream') and current.get('action') in ('update', 'stale') and (n == 1):
                content = [{'type': 'tool_use', 'id': 'tool_bg_write', 'name': 'Write', 'input': {'file_path': str(current['memory'] / 'probe-topic.md'), 'content': '---\nname: probe-topic\ndescription: Updated synthetic preference\nmetadata:\n  type: feedback\n---\nPROBE_UPDATED_BY_BACKGROUND\n'}}]
            if phase in ('extract', 'dream') and (n == 0 and current.get('action') == 'guard' or current.get('action') == 'budget'):
                content = [{'type': 'tool_use', 'id': 'tool_bg_outside', 'name': 'Write', 'input': {'file_path': str(current['outside']), 'content': 'MUST_NOT_BE_WRITTEN'}}]
            message = {'id': f'msg_probe_{len(requests)}', 'type': 'message', 'role': 'assistant', 'model': body.get('model', 'claude-sonnet-4-6'), 'content': content, 'stop_reason': 'tool_use' if content[0]['type'] == 'tool_use' else 'end_turn', 'stop_sequence': None, 'usage': {'input_tokens': 128, 'output_tokens': 5}}
            if not body.get('stream'):
                self.reply(message)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            start = {**message, 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 128, 'output_tokens': 0}}
            events = [('message_start', {'type': 'message_start', 'message': start})]
            for i, b in enumerate(content):
                blank = {**b, 'text': ''} if b['type'] == 'text' else {**b, 'input': {}}
                delta = {'type': 'text_delta', 'text': b['text']} if b['type'] == 'text' else {'type': 'input_json_delta', 'partial_json': json.dumps(b['input'])}
                events.extend([('content_block_start', {'type': 'content_block_start', 'index': i, 'content_block': blank}), ('content_block_delta', {'type': 'content_block_delta', 'index': i, 'delta': delta}), ('content_block_stop', {'type': 'content_block_stop', 'index': i})])
            events.extend([('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': message['stop_reason'], 'stop_sequence': None}, 'usage': {'output_tokens': 5}}), ('message_stop', {'type': 'message_stop'})])
            try:
                for event, val in events:
                    self.wfile.write(f'event: {event}\ndata: {json.dumps(val)}\n\n'.encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
    api = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='cc-native-memory-maintenance-') as tmp:
            root = Path(tmp).resolve()
            policy = f'(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(deny file-read* file-write* (subpath {json.dumps(str(real_home))}))(allow file-read* (literal {json.dumps(str(binary))}))'
            subprocess.run(['/usr/bin/sandbox-exec', '-p', policy, '/usr/bin/true'], check=True)
            negative = subprocess.run(['/usr/bin/sandbox-exec', '-p', policy, '/usr/bin/curl', '--noproxy', '*', '--connect-timeout', '2', '--max-time', '3', 'http://1.1.1.1'], capture_output=True, text=True)
            assert negative.returncode != 0, 'Outbound network negative control failed'
            cases = [
                ('baseline_off', {}),
                ('extract_on', {'extract': True}),
                ('headless_gate_off', {'extract': True, 'slate': False}),
                ('cadence_two', {'extract': True, 'cadence': 2}),
                ('no_user_prose', {'extract': True, 'prompt': 'PROBE中文没有空格'}),
                ('native_disabled', {'extract': True, 'disabled': True}),
                ('direct_write', {'extract': True, 'action': 'write'}),
                ('failed_direct_edit', {'extract': True, 'action': 'failed_edit'}),
                ('extract_write_guard', {'extract': True, 'action': 'guard'}),
                ('extract_update_existing', {'extract': True, 'action': 'update'}),
                ('dream_print_sdk', {'dream': True}),
                ('extract_turn_limit', {'extract': True, 'action': 'budget'}),
                ('dream_forced_desktop', {'dream': True, 'entrypoint': 'claude-desktop'}),
                ('dream_time_gate', {'dream': True, 'entrypoint': 'claude-desktop', 'lock_age': 0}),
                ('dream_sessions_gate', {'dream': True, 'entrypoint': 'claude-desktop', 'min_sessions': 2}),
                ('dream_live_lock', {'dream': True, 'entrypoint': 'claude-desktop', 'lock_age': 60, 'live_lock': True}),
                ('dream_write_guard', {'dream': True, 'entrypoint': 'claude-desktop', 'action': 'guard'}),
                ('dream_update_existing', {'dream': True, 'entrypoint': 'claude-desktop', 'action': 'update'}),
                ('dream_turn_limit', {'dream': True, 'entrypoint': 'claude-desktop', 'action': 'budget'}),
                ('dream_setting_off', {'dream': True, 'entrypoint': 'claude-desktop', 'setting': False}),
                ('dream_unavailable', {'dream': True, 'entrypoint': 'claude-desktop', 'flag_enabled': False, 'available': False}),
                ('dream_available_opt_in', {'dream': True, 'entrypoint': 'claude-desktop', 'flag_enabled': False, 'available': True}),
                ('extract_stale_notice', {'extract': True, 'stream': True, 'second_turn': True, 'action': 'stale'}),
                ('dream_stale_notice', {'dream': True, 'entrypoint': 'claude-desktop', 'second_turn': True, 'action': 'stale'}),
            ]
            for name, opts in cases:
                if selected and name not in selected:
                    continue
                workspace = root / name
                config = workspace / 'config'
                memory = workspace / 'memory'
                for folder in [workspace, config, memory]:
                    folder.mkdir(mode=0o700)
                flags = {'tengu_passport_quail': opts.get('extract', False), 'tengu_slate_thimble': opts.get('slate', True), 'tengu_bramble_lintel': opts.get('cadence', 1), 'tengu_onyx_plover': {'enabled': opts.get('flag_enabled', opts.get('dream', False)), 'available': opts.get('available', True), 'minHours': 0.001, 'minSessions': opts.get('min_sessions', 1)}, 'tengu_stone_shell': False, 'tengu_moth_copse': False, 'tengu_herring_clock': False}
                conf = {'hasCompletedOnboarding': True, 'cachedGrowthBookFeatures': flags, 'cachedGrowthBookFeaturesAt': int(time.time() * 1000), 'projects': {str(workspace): {'hasTrustDialogAccepted': True}}}
                (config / '.claude.json').write_text(json.dumps(conf))
                topic = memory / 'probe-topic.md'
                topic.write_text('---\nname: probe-topic\ndescription: Synthetic preference\nmetadata:\n  type: feedback\n---\nPROBE_ORIGINAL_BODY\n')
                (memory / 'MEMORY.md').write_text('- [Synthetic preference](probe-topic.md) — PROBE_SYNTHETIC_INDEX\n')
                env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(workspace), 'CLAUDE_CONFIG_DIR': str(config), 'TMPDIR': str(root), 'ANTHROPIC_API_KEY': DUMMY, 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{api.server_port}', 'DISABLE_ERROR_REPORTING': '1', 'DISABLE_AUTOUPDATER': '1', 'CI': '1', 'LANG': 'en_US.UTF-8', 'SHELL': '/bin/zsh'}
                if opts.get('disabled'):
                    env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] = '1'
                if opts.get('entrypoint'):
                    env['CLAUDE_CODE_ENTRYPOINT'] = opts['entrypoint']
                settings = json.dumps({'autoMemoryDirectory': str(memory), 'autoDreamEnabled': opts.get('setting', opts.get('dream', False))})
                args = [str(binary), '-p', '--model', 'claude-sonnet-4-6', '--output-format', 'stream-json', '--verbose', '--debug-file', str(out / (name + '.debug.txt')), '--settings', settings, opts.get('prompt', 'Remember this synthetic durable preference for future conversations.'), '--allowedTools', 'Read,Write,Edit,Bash', '--strict-mcp-config']
                if opts.get('dream') or opts.get('stream'):
                    args.remove(opts.get('prompt', 'Remember this synthetic durable preference for future conversations.'))
                    args.extend(['--input-format', 'stream-json'])
                user_frame = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': opts.get('prompt', 'Remember this synthetic durable preference for future conversations.')}}) + '\n'
                if opts.get('dream'):
                    current.clear()
                    current.update(name=name + '-seed', memory=memory, outside=workspace / 'outside.md')
                    seed_env = dict(env)
                    seed_env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] = '1'
                    seed = subprocess.run(['/usr/bin/sandbox-exec', '-p', policy, *args], cwd=workspace, env=seed_env, input=user_frame, capture_output=True, text=True, timeout=35)
                    assert seed.returncode == 0, 'Seed CLI failed'
                    old = time.time() - opts.get('lock_age', 48 * 3600)
                    lk = memory / '.consolidate-lock'
                    lk.write_text(str(os.getpid()) if opts.get('live_lock') else '')
                    os.utime(lk, (old, old))
                current.clear()
                current.update(name=name, memory=memory, outside=workspace / 'outside.md', action=opts.get('action'), slow_main=opts.get('dream', False) or opts.get('stream', False))
                begin = len(requests)
                start = time.monotonic()
                p = subprocess.Popen(['/usr/bin/sandbox-exec', '-p', policy, *args], cwd=workspace, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.PIPE if opts.get('dream') or opts.get('stream') else None, text=True, start_new_session=True)
                if opts.get('dream') or opts.get('stream'):
                    p.stdin.write(user_frame)
                    p.stdin.flush()
                    if opts.get('second_turn'):
                        time.sleep(1.4)
                        p.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': 'Please recall the synthetic preference again.'}}) + '\n')
                        p.stdin.flush()
                        time.sleep(1.4)
                    else:
                        time.sleep(2)
                    p.stdin.close()
                    p.stdin = None
                try:
                    stdout, stderr = p.communicate(timeout=45)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
                    stdout, stderr = p.communicate()
                for suffix, text in [('stdout', stdout), ('stderr', stderr)]:
                    f = out / (name + '.' + suffix + '.txt')
                    f.write_text(text)
                    f.chmod(0o600)
                recs = requests[begin:]
                bg = [r for r in recs if r['phase'] in ('extract', 'dream')]
                main_recs = [r for r in recs if r['phase'] == 'main']
                summary = {'case': name, 'exit_code': p.returncode, 'elapsed_seconds': round(time.monotonic() - start, 2), 'counts': dict(current.get('counts', {})), 'outside_written': current['outside'].exists(), 'stale_notice_seen': any(('Your loaded copy of' in text and 'is now stale relative to disk' in text for r in main_recs for text in blocks(r['body']))), 'main_body_changed': 'PROBE_UPDATED_BY_MAIN' in topic.read_text(), 'background_body_changed': 'PROBE_UPDATED_BY_BACKGROUND' in topic.read_text(), 'lock_exists': (memory / '.consolidate-lock').exists(), 'lock_age_seconds_after': round(time.time() - (memory / '.consolidate-lock').stat().st_mtime, 2) if (memory / '.consolidate-lock').exists() else None, 'background_tool_names_match_main': all(([t['name'] for t in r['body'].get('tools', [])] == [t['name'] for t in main_recs[0]['body'].get('tools', [])] for r in bg)) if bg and main_recs else None, 'background_system_text_matches_main': all(([b.get('text', '') for b in r['body'].get('system', [])] == [b.get('text', '') for b in main_recs[0]['body'].get('system', [])] for r in bg)) if bg and main_recs else None, 'request_files': [f'request-{i + 1:03d}.json' for i in range(begin, len(requests))]}
                results.append(summary)
                print(json.dumps(summary), flush=True)
            manifest = {'version': '2.1.283', 'binary_sha256': HASH, 'scope': 'Isolated native CLI against fake loopback API; deterministic synthetic model replies', 'network': 'Child sandbox permits outbound localhost only; negative curl nonzero', 'filesystem': 'Child cannot read or write real user home except reading the verified Claude binary', 'production_modified': False, 'real_model_called': False, 'cases': results}
            f = out / 'probe-summary.json'
            f.write_text(json.dumps(manifest, indent=2))
            f.chmod(0o600)
    finally:
        api.shutdown()
        api.server_close()
if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('binary', type=Path)
    p.add_argument('destination', type=Path)
    p.add_argument('--case', action='append')
    a = p.parse_args()
    main(a.binary, a.destination, a.case)
