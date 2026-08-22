import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-claudesess-test-${Date.now()}`);
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = tmp;

const {
  projectSlug,
  isSessionId,
  isHiddenUserLine,
  isInjectedUserLine,
  listClaudeSessions,
  getClaudeSessionMessages,
  deleteClaudeSession,
} = await import("./claude-sessions.ts");

const userLine = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: `u-${text.slice(0, 6)}`,
  sessionId: "11111111-2222-4333-8444-555555555555",
  timestamp: "2026-08-22T00:00:00.000Z",
  cwd: "/tmp/proj",
  message: { role: "user", content: [{ type: "text", text }] },
  ...extra,
});

try {
  // ── slug (derived empirically against 706 real dirs) ──────────────────────

  assert.equal(
    projectSlug("/Users/xuqiang/code/cc-webui"),
    "-Users-xuqiang-code-cc-webui",
  );
  // dots collapse too — a hidden dir becomes a doubled dash
  assert.equal(
    projectSlug("/Users/x/code/.claude/wt"),
    "-Users-x-code--claude-wt",
  );
  // lossy for non-ASCII, which is why the mapping is only ever used forwards
  // "/" plus one dash per CJK char → three trailing dashes, not four.
  assert.equal(projectSlug("/Users/x/下载"), "-Users-x---");
  assert.equal(projectSlug("/a_b/c.d-e"), "-a-b-c-d-e");

  // ── session id gate (also what keeps `id` from escaping the root) ─────────

  assert.equal(isSessionId("11111111-2222-4333-8444-555555555555"), true);
  assert.equal(isSessionId("../../etc/passwd"), false);
  assert.equal(isSessionId("not-a-uuid"), false);
  assert.equal(isSessionId(""), false);

  // ── line filters, matching what the SDK reader hid ───────────────────────

  assert.equal(isHiddenUserLine(userLine("hello")), false);
  assert.equal(isHiddenUserLine(userLine("x", { isMeta: true })), true);
  assert.equal(
    isHiddenUserLine(userLine("<command-message>foo</command-message>")),
    true,
    "slash-command echo must not render as a user turn",
  );
  assert.equal(
    isHiddenUserLine(userLine("<local-command-caveat>x")),
    true,
  );
  // A real message that merely mentions the tag is NOT an echo.
  assert.equal(
    isHiddenUserLine(userLine("why does <command-message> appear?")),
    false,
  );
  // Injected turns stay in history but must not become firstPrompt.
  const injected = userLine("<task-notification>\n<task-id>a1</task-id>");
  assert.equal(isHiddenUserLine(injected), false, "kept in history");
  assert.equal(isInjectedUserLine(injected), true, "excluded from firstPrompt");
  assert.equal(isInjectedUserLine(userLine("hello")), false);

  // ── end to end over a fixture project dir ────────────────────────────────

  const sid = "11111111-2222-4333-8444-555555555555";
  const dir = path.join(tmp, projectSlug("/tmp/proj"));
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    { type: "queue-operation", operation: "x" },
    userLine("<local-command-caveat>ignored", { isMeta: true }),
    userLine("<task-notification>\n<task-id>a1</task-id>"),
    userLine("the real first prompt"),
    {
      type: "assistant",
      uuid: "a-1",
      sessionId: sid,
      timestamp: "2026-08-22T00:00:01.000Z",
      cwd: "/tmp/proj",
      parentToolUseId: "toolu_9",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    },
    { type: "ai-title", sessionId: sid, aiTitle: "an early title" },
    { type: "ai-title", sessionId: sid, aiTitle: "the newest title" },
    "{ this line is not json",
  ];
  await fs.writeFile(
    path.join(dir, `${sid}.jsonl`),
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );

  const msgs = await getClaudeSessionMessages(sid, { dir: "/tmp/proj" });
  assert.deepEqual(
    msgs.map((m) => m.type),
    ["user", "user", "assistant"],
    "meta + echo lines dropped; injected turn kept; non-message lines ignored",
  );
  assert.equal(msgs[0].parent_tool_use_id, null);
  assert.equal(msgs[2].parent_tool_use_id, "toolu_9", "parentToolUseId → snake_case");
  assert.equal(msgs[2].session_id, sid, "sessionId → session_id");

  // A limit keeps the most recent messages — the UI opens scrolled to the end.
  const tail = await getClaudeSessionMessages(sid, { dir: "/tmp/proj", limit: 1 });
  assert.equal(tail.length, 1);
  assert.equal(tail[0].type, "assistant");

  // Found without a dir hint too (scan by filename, no slug math).
  assert.equal((await getClaudeSessionMessages(sid)).length, 3);

  const list = await listClaudeSessions({ limit: 10, dir: "/tmp/proj" });
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, sid);
  assert.equal(list[0].provider, "claude");
  assert.equal(list[0].cwd, "/tmp/proj");
  assert.equal(
    list[0].summary,
    "the newest title",
    "the LAST ai-title wins — the CLI appends one per turn",
  );
  assert.equal(list[0].customTitle, "the newest title");
  assert.equal(
    list[0].firstPrompt,
    "the real first prompt",
    "meta and injected turns must not become firstPrompt",
  );

  // ── delete ───────────────────────────────────────────────────────────────

  assert.equal(await deleteClaudeSession("../../etc/passwd"), false, "non-uuid refused");
  assert.equal(await deleteClaudeSession(sid, { dir: "/tmp/proj" }), true);
  assert.equal(await deleteClaudeSession(sid, { dir: "/tmp/proj" }), false, "already gone");
  assert.deepEqual(await listClaudeSessions({ limit: 10, dir: "/tmp/proj" }), []);

  console.log("claude-sessions.test.ts: all assertions passed");
} finally {
  delete process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
}
