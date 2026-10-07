import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wrapMemoryPrompt } from "../shared/project-memory-envelope.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-codex-history-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex");
await fs.mkdir(process.env.CODEX_SESSIONS_DIR, { recursive: true });
const { getCodexSessionTurns, listCodexSessions } = await import("./session-store.ts");
const { closeDb } = await import("./db.ts");
const id = "11111111-1111-4111-8111-111111111111";
const original = "第一行\n\n第二行\n附件：\n- /tmp/a.docx  (a.docx)";
const wrapped = wrapMemoryPrompt({ source: "cc-webui-project-memory-v1", scope: "test", revision: 1,
  total: 1, entries: [{ id: "m1", name: "INDEX_SENTINEL", description: "hidden", type: "project", revision: 1 }], truncated: false }, original, "runtime rules");
const record = (ms: number, type: string, payload: unknown) => ({ timestamp: new Date(ms).toISOString(), type, payload });
const item = (ms: number, value: unknown) => record(ms, "event_msg", { type: "item_completed", item: value });
try {
  const rows = [
    record(1, "session_meta", { id, cwd: tmp }),
    record(2, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>SECRET CONTEXT</environment_context>" }] }),
    record(3, "event_msg", { type: "task_started" }),
    item(10, { type: "UserMessage", id: "u1", content: [{ type: "text", text: wrapped }] }),
    item(11, { type: "Reasoning", id: "r1", raw_content: ["PRIVATE_REASONING"] }),
    item(12, { type: "McpToolCall", id: "m1", server: "memory", tool: "read", status: "completed", arguments: {}, result: { Ok: { content: [] } } }),
    item(13, { type: "CommandExecution", id: "s1", command: ["echo", "ok"], status: "completed", aggregated_output: "ok\n" }),
    item(14, { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "# 回复\n\n- 一\n- 二" }], phase: "final_answer" }),
    // response_item duplicates the public message: it must NOT render twice.
    record(15, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "# 回复\n\n- 一\n- 二" }] }),
    record(16, "event_msg", { type: "task_complete" }),
    item(20, { type: "UserMessage", id: "u2", content: [{ type: "text", text: "WEBUI RUNTIME: rules\n\nUSER REQUEST:\n新的问题\n保持换行" }] }),
  ];
  const file = path.join(process.env.CODEX_SESSIONS_DIR!, `rollout-${id}.jsonl`);
  await fs.writeFile(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const turns = await getCodexSessionTurns(id);
  assert.deepEqual(turns.map(t => t.prompt), [original, "新的问题\n保持换行"], "new rollout user items create distinct turns, including an unfinished one");
  assert.equal(turns[0].events.length, 3, "no private reasoning or duplicate response items");
  assert.doesNotMatch(JSON.stringify(turns), /INDEX_SENTINEL|PRIVATE_REASONING|SECRET CONTEXT|runtime rules/);
  assert.match(JSON.stringify(turns[0].events), /# 回复\\n\\n- 一\\n- 二/);
  const summary = (await listCodexSessions({ limit: 10 }))[0];
  assert.equal(summary.firstPrompt, original);

  // Retain support for older event_msg layouts, without compacting before
  // memory-envelope removal or flattening markdown in the displayed reply.
  await fs.writeFile(file, [
    record(1, "session_meta", { id, cwd: tmp }),
    record(10, "event_msg", { type: "user_message", message: wrapped }),
    record(11, "event_msg", { type: "agent_message", message: "# 旧回复\n\n正文" }),
  ].map(r => JSON.stringify(r)).join("\n"));
  const legacy = await getCodexSessionTurns(id);
  assert.equal(legacy[0].prompt, original);
  assert.match(JSON.stringify(legacy[0].events), /# 旧回复\\n\\n正文/);
  assert.equal((await listCodexSessions({ limit: 10 }))[0].firstPrompt, original, "rewrite invalidates the native summary cache");
  const renamedCwd = path.join(tmp, "renamed-project"), future = Date.now() + 60_000;
  await fs.appendFile(file, "\n" + [
    record(20, "event_msg", { type: "thread_name_updated", thread_name: "retained middle title" }),
    record(future, "response_item", { type: "reasoning", raw_content: "PRIVATE_PAYLOAD".repeat(100_000) }),
    record(30, "turn_context", { cwd: renamedCwd }),
  ].map(r => JSON.stringify(r)).join("\n"));
  const changed = (await listCodexSessions({ limit: 10, cwd: renamedCwd }))[0];
  assert.equal(changed.customTitle, "retained middle title", "titles outside a small tail window are not lost for speed");
  assert.equal(changed.lastModified, future, "ignored payloads still contribute timestamps");
  assert.doesNotMatch(JSON.stringify(changed), /PRIVATE_PAYLOAD/);
  await fs.unlink(file);
  assert.deepEqual(await listCodexSessions({ limit: 10 }), [], "deleted native files disappear despite warm metadata");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log("Codex native rollout users parsed without leaking injected context");
