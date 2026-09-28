// 续聊的会话已经被删掉时，POST /api/chat 直接当新对话起（不带 --resume），
// 而不是让 CLI 回「No conversation found」（用户 2026-09-23：删掉正开着的会话、刷新之后，
// 每发一条都是这句错误）。反过来也要钉住：会话文件还在的，照旧 --resume。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-resume-gone-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");
await fs.mkdir(path.join(tmp, "work"), { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

// 假 claude：读到 stdin 的第一行（用户消息）就回 init / assistant / result，
// stdin 关掉后自然退出。chat.ts 每一轮都走 stdin 协议（它总是传 onPermissionAsk）。
const FAKE = `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
let done = false;
rl.on("line", () => {
  if (done) return;
  done = true;
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555", model: "claude-opus-5-5" });
  out({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: process.argv.includes("--resume") ? "resume:yes" : "resume:no" }] } });
  out({ type: "result", subtype: "success", session_id: "11111111-2222-4333-8444-555555555555" });
});
`;
const bin = path.join(tmp, "fake-claude.cjs");
await fs.writeFile(bin, FAKE);
await fs.chmod(bin, 0o755);
process.env.CC_WEBUI_CLAUDE_BIN = bin;

const { closeDb } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { createUser } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { projectSlug } = await import("./claude-sessions.ts");

try {
  const app = createApp();
  const admin = createUser({ username: "root", password: "x", role: "admin", allowedPaths: ["**"] });
  const work = path.join(tmp, "work");
  const turnText = async (sessionId: string) => {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${issueSession(admin.id)}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", cwd: work, sessionId }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    return /resume:(yes|no)/.exec(text)?.[0];
  };

  // ── 1. 会话文件哪儿都没有（被删了）→ 不带 --resume，当新对话 ────────────
  assert.equal(await turnText("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), "resume:no");

  // ── 2. 会话文件还在 → 照旧 --resume ─────────────────────────────────────
  const alive = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const dir = path.join(tmp, "claude-projects", projectSlug(work));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${alive}.jsonl`), "{}\n");
  assert.equal(await turnText(alive), "resume:yes", "an existing session must still be resumed");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
