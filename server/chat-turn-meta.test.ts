// 思考状态行里的「· xhigh effort」必须是**这一轮**的 effort，不是看的人的设置。
//
// 起因（用户 2026-09-23）：rebecca 用 xhigh 发的一轮，管理员打开同一个会话看，
// 状态行写的是 max —— 那是管理员自己输入框里的档位。CLI 的 system/init 帧里只有
// model 没有 effort，所以由 chat.ts 在每一轮 buffer 的**第一条**补一帧 turn_meta，
// 前端只认它。这里走真实的 POST /api/chat + 一个假 CLI，把这条合同钉死：
// 第一帧是 turn_meta、写的是请求里的 effort，没带 effort 时是 null（前端就不显示）。
//
// 为什么要假 CLI：真 claude 在测试里跑不了（要登录、要钱、要网），而这条合同
// 恰恰长在「起一轮」的路径上，纯函数测不到。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-turn-meta-test-${Date.now()}`);
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
  out({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }] } });
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

type Frame = { event: string; data: string };
function parseSSE(text: string): Frame[] {
  return text
    .split("\n\n")
    .map((block) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      return { event, data };
    })
    .filter((f) => f.data || f.event !== "message");
}

try {
  const app = createApp();
  const admin = createUser({
    username: "root",
    password: "x",
    role: "admin",
    allowedPaths: ["**"],
  });
  const turn = async (body: Record<string, unknown>) => {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${issueSession(admin.id)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "hi", cwd: path.join(tmp, "work"), ...body }),
    });
    assert.equal(res.status, 200, "turn must start");
    return parseSSE(await res.text()).filter((f) => f.event !== "ping");
  };

  // ── 1. 带了 effort：第一帧就是它 ──────────────────────────────────────────
  let frames = await turn({ model: "opus", effort: "xhigh" });
  assert.equal(frames[0]?.event, "turn_meta", "turn_meta must be the first frame of the turn");
  assert.deepEqual(JSON.parse(frames[0].data), { type: "turn_meta", effort: "xhigh" });
  assert.ok(
    frames.some((f) => f.event === "assistant"),
    "the fake CLI's frames still come through after it",
  );

  // ── 2. 没带 effort：null，而不是某个猜出来的默认值 ───────────────────────
  frames = await turn({ model: "opus" });
  assert.equal(frames[0]?.event, "turn_meta");
  assert.equal(
    JSON.parse(frames[0].data).effort,
    null,
    "unknown effort must say so — the CLI's own default is not ours to guess",
  );

  // ── 3. 瞎写的 effort 被请求校验挡掉，turn_meta 不能把它原样报出去 ─────────
  frames = await turn({ model: "opus", effort: "bogus" });
  assert.equal(JSON.parse(frames[0].data).effort, null);
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
