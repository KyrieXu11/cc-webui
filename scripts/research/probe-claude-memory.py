#!/usr/bin/env python3
"""Capture native memory prompts with synthetic fixtures and a loopback fake API.

Never uses real credentials, project files, or a live model. The Claude process
runs with an isolated HOME/config and macOS outbound networking restricted to
localhost. Captures belong in a private persistent research directory.
"""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def probe(binary: Path, destination: Path, models: list[str]) -> None:
    policy = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
    subprocess.run(["/usr/bin/sandbox-exec", "-p", policy, "/usr/bin/true"], check=True)
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    requests = []
    lock = threading.Lock()
    current_case = "startup"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, value, code=200):
            data = json.dumps(value).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply({"data": [{"id": m, "type": "model", "display_name": m} for m in models], "has_more": False})

        def do_POST(self):
            if "/messages" in self.path:
                dummy = "sk-ant-local-fake-memory-probe-only"
                key, authorization = self.headers.get("x-api-key"), self.headers.get("authorization")
                if not ((key == dummy and authorization is None) or (key is None and authorization == "Bearer " + dummy)):
                    self.reply({"error": "Probe rejected unexpected authentication; credential values are never logged"}, 401)
                    return
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            with lock:
                case = current_case
                record = {"case": case, "path": self.path, "dummy_auth_verified": "/messages" in self.path, "body": body}
                requests.append(record)
                file = destination / f"request-{len(requests):03d}.json"
                file.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
                file.chmod(0o600)
            if self.path.endswith("/count_tokens"):
                self.reply({"input_tokens": 128})
                return
            if "/messages" not in self.path:
                self.reply({})
                return
            message = {"id": "msg_local_memory_probe", "type": "message", "role": "assistant", "model": body.get("model", models[0]), "content": [{"type": "text", "text": "probe-ok"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 128, "output_tokens": 3}}
            if not body.get("stream"):
                self.reply(message)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            start = {**message, "content": [], "stop_reason": None, "usage": {"input_tokens": 128, "output_tokens": 0}}
            events = [
                ("message_start", {"type": "message_start", "message": start}),
                ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "probe-ok"}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 3}}),
                ("message_stop", {"type": "message_stop"}),
            ]
            for event, value in events:
                self.wfile.write(f"event: {event}\ndata: {json.dumps(value)}\n\n".encode())
            self.wfile.flush()

    api = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=api.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{api.server_port}"
    summaries = []
    try:
        with tempfile.TemporaryDirectory(prefix="cc-claude-memory-probe-") as temporary:
            root = Path(temporary).resolve()
            for model in models:
                workspace = root / model
                config = workspace / "config"
                memory = workspace / "memory"
                for folder in [workspace, config, memory]:
                    folder.mkdir(mode=0o700)
                (config / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True, "projects": {str(workspace): {"hasTrustDialogAccepted": True}}}))
                (memory / "user-probe.md").write_text("---\nname: user-probe\ndescription: Synthetic probe preference\ntype: user\n---\nPROBE_BODY_NOT_AUTO_INJECTED\n")
                settings = json.dumps({"autoMemoryDirectory": str(memory)})
                env = {
                    "PATH": os.environ["PATH"], "HOME": str(workspace),
                    "CLAUDE_CONFIG_DIR": str(config), "TMPDIR": str(root),
                    "ANTHROPIC_API_KEY": "sk-ant-local-fake-memory-probe-only",
                    "ANTHROPIC_BASE_URL": base_url,
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
                    "DISABLE_AUTOUPDATER": "1", "CI": "1",
                    "LANG": "en_US.UTF-8", "SHELL": "/bin/zsh",
                }
                session = str(uuid.uuid4())
                common = [str(binary), "--print", "--model", model, "--output-format", "stream-json", "--verbose", "--settings", settings]
                for case in ["new", "resume", "disabled"]:
                    current_case = f"{model}-{case}"
                    (memory / "MEMORY.md").write_text(f"# Probe memory index\n- [Synthetic probe preference](user-probe.md) — PROBE_INDEX_{'v2' if case == 'resume' else 'v1'}\n")
                    case_env = dict(env)
                    if case == "disabled":
                        case_env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
                    args = common + (["--resume", session] if case == "resume" else ["--session-id", session if case == "new" else str(uuid.uuid4())]) + ["Reply with probe-ok. Do not call any tools."]
                    restricted = ["/usr/bin/sandbox-exec", "-p", policy, *args]
                    before = len(requests)
                    start = time.monotonic()
                    try:
                        result = subprocess.run(restricted, cwd=workspace, env=case_env, capture_output=True, text=True, timeout=40)
                        exit_code, stdout, stderr = result.returncode, result.stdout, result.stderr
                    except subprocess.TimeoutExpired as error:
                        exit_code, stdout, stderr = -1, str(error.stdout or ""), str(error.stderr or "")
                    for suffix, content in [("stdout", stdout), ("stderr", stderr)]:
                        log = destination / f"{current_case}.{suffix}.txt"
                        log.write_text(content); log.chmod(0o600)
                    summary = {"case": current_case, "exit_code": exit_code, "request_count": len(requests) - before, "elapsed_seconds": round(time.monotonic() - start, 2), "memory_dir": str(memory)}
                    summaries.append(summary)
                    print(json.dumps(summary), flush=True)
    finally:
        api.shutdown(); api.server_close()
        manifest = destination / "probe-manifest.json"
        manifest.write_text(json.dumps({"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "api": "loopback fake Anthropic API only", "outbound_network": "restricted to localhost", "cases": summaries}, indent=2) + "\n")
        manifest.chmod(0o600)
    if any(case["exit_code"] != 0 or case["request_count"] == 0 for case in summaries):
        raise RuntimeError("One or more probes failed; inspect the persistent case logs")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--model", action="append")
    args = parser.parse_args()
    probe(args.binary.resolve(), args.destination, args.model or ["claude-sonnet-4-6", "claude-opus-5-5"])
