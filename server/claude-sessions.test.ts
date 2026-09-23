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
  summarize,
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

  // ── 头部被巨大的 bookkeeping 行顶满 ──────────────────────────────────────
  //
  // 2026-09-07 用户报的「怎么看不到 rebecca 的会话了」就是这个：CLI 把
  // `queue-operation`（排队中的消息，带附件时一条上百 KB —— 现场最长的一行
  // 1.84MB）写在文件最前面，两条就填满头部 256KB 的窗口，于是窗口里一个 cwd、
  // 一个 user 行都不剩，`summaryFor` 返回 null，**整条会话在侧栏和顶栏搜索里
  // 消失**，而文件好好地躺在盘上。
  const qDir = path.join(tmp, projectSlug("/tmp/queued"));
  await fs.mkdir(qDir, { recursive: true });
  const qSid = "99999999-8888-4777-8666-555555555555";
  const fat = (n: number) =>
    JSON.stringify({ type: "queue-operation", n, blob: "x".repeat(200_000) });
  await fs.writeFile(
    path.join(qDir, `${qSid}.jsonl`),
    [
      // 两条各 200KB，加起来越过 HEAD_BYTES（256KB）—— 快路径必然空手而归。
      fat(1),
      fat(2),
      JSON.stringify({
        type: "user",
        uuid: "u-1",
        sessionId: qSid,
        timestamp: "2026-09-07T00:00:00.000Z",
        cwd: "/tmp/queued",
        message: { role: "user", content: [{ type: "text", text: "帮我做课件" }] },
      }),
    ].join("\n") + "\n",
  );

  const queued = await listClaudeSessions({ limit: 10, dir: "/tmp/queued" });
  assert.equal(queued.length, 1, "头部窗口捞不到时必须回退到按行扫，而不是丢掉这条会话");
  assert.equal(queued[0].sessionId, qSid);
  assert.equal(queued[0].cwd, "/tmp/queued");
  assert.equal(queued[0].firstPrompt, "帮我做课件");

  // 反面：真的只有 bookkeeping、一条消息都没有的文件仍然不进列表 —— 那是「起了
  // 个会话、一个 turn 都没跑完」的残桩，列出来是一行空白。
  const stubSid = "77777777-6666-4555-8444-333333333333";
  await fs.writeFile(
    path.join(qDir, `${stubSid}.jsonl`),
    [
      JSON.stringify({ type: "last-prompt" }),
      JSON.stringify({ type: "mode", mode: "default" }),
      JSON.stringify({ type: "cost-state" }),
    ].join("\n") + "\n",
  );
  assert.deepEqual(
    (await listClaudeSessions({ limit: 10, dir: "/tmp/queued" })).map((x) => x.sessionId),
    [qSid],
    "只有 bookkeeping 的残桩不列",
  );

  // 没有 ai-title 时标题退回第一条消息：带附件的那种不能把临时目录路径当标题。
  const att = "附件：\n- /var/folders/48/x/T/cc-webui-uploads/mu-笔记.pdf  (笔记.pdf)\n\n做成 PPT";
  assert.equal(summarize(att), "做成 PPT", "title uses the message, not the upload path");
  assert.equal(
    summarize("附件：\n- /t/a-x.pdf  (x.pdf)\n- /t/b-y.pdf  (y.pdf)"),
    "x.pdf、y.pdf",
    "attachment-only message → file names",
  );
  assert.equal(summarize("普通 的\n消息"), "普通 的 消息", "no attachment: unchanged");

  console.log("claude-sessions.test.ts: all assertions passed");
} finally {
  delete process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
}
