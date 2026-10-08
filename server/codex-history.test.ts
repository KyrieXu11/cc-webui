import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wrapMemoryPrompt } from "../shared/project-memory-envelope.ts";
import { sessionMessagesToEvents } from "../src/lib/processor.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UserBubble from "../src/components/UserBubble.tsx";

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

  // CLI 0.161.0 embeds bytes in response_item, but its UserMessage contains
  // only a temp path that the executor removes. Reopen must restore the bytes
  // exactly once without opening arbitrary paths or leaking them to summaries.
  const image = { mediaType: "image/png", data: "aW1hZ2U=" };
  const image2 = { mediaType: "image/jpeg", data: "c2Vjb25k" };
  const inputImage = (img = image) => ({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}` });
  const localImage = { type: "local_image", path: path.join(tmp, "DO_NOT_READ.txt") };
  await fs.writeFile(localImage.path, "PRIVATE_LOCAL_FILE");
  await fs.writeFile(file, [
    record(1, "session_meta", { id, cwd: tmp }),
    record(2, "event_msg", { type: "task_started" }),
    record(3, "response_item", { type: "message", role: "user", content: [inputImage(), inputImage(image2), { type: "input_text", text: wrapped }] }),
    item(4, { type: "UserMessage", id: "image-u1", content: [localImage, { type: "text", text: wrapped }] }),
    item(5, { type: "AgentMessage", id: "image-a1", content: [{ type: "text", text: "reply" }] }),
    record(6, "event_msg", { type: "task_complete" }),
    record(7, "event_msg", { type: "task_started" }),
    record(8, "response_item", { type: "message", role: "developer", content: [inputImage()] }),
    record(9, "response_item", { type: "message", role: "user", content: [
      { type: "input_image", image_url: "https://example.invalid/private.png" },
      { type: "input_image", image_url: `file://${localImage.path}` },
      { type: "input_image", image_url: "data:text/html;base64,PHNjcmlwdD4=" },
      { type: "input_image", image_url: "data:image/png;base64,not-base64!" },
    ] }),
    item(10, { type: "UserMessage", id: "image-u2", content: [localImage, { type: "text", text: wrapped }] }),
    record(11, "event_msg", { type: "task_complete" }),
    record(12, "event_msg", { type: "task_started" }),
    item(13, { type: "UserMessage", id: "image-only", content: [localImage] }),
    record(14, "response_item", { type: "message", role: "user", content: [inputImage()] }),
    record(15, "event_msg", { type: "task_complete" }),
    record(16, "event_msg", { type: "task_started" }),
    record(17, "response_item", { type: "message", role: "user", content: [inputImage()] }),
    // An interrupted task without UserMessage must not lend images to the next.
    record(18, "event_msg", { type: "turn_aborted" }),
    record(19, "event_msg", { type: "task_started" }),
    item(20, { type: "UserMessage", id: "no-image", content: [{ type: "text", text: "next question" }] }),
  ].map(r => JSON.stringify(r)).join("\n"));
  const imageTurns = await getCodexSessionTurns(id);
  assert.deepEqual(imageTurns.map(t => t.images), [[image, image2], undefined, [image], undefined]);
  const userEvents = sessionMessagesToEvents(imageTurns).filter(e => e.type === "user");
  assert.deepEqual(userEvents.map(e => e.text), [original, original, "", "next question"]);
  assert.deepEqual(userEvents.map(e => e.images), [[image, image2], undefined, [image], undefined]);
  const bubble = renderToStaticMarkup(createElement(UserBubble, { text: userEvents[0].text, images: userEvents[0].images }));
  assert.equal((bubble.match(/<img /g) ?? []).length, 2, "reopened history renders the images, not just their text");
  assert.match(bubble, /src="data:image\/png;base64,aW1hZ2U="/);
  assert.doesNotMatch(JSON.stringify(imageTurns), /DO_NOT_READ|PRIVATE_LOCAL_FILE|example.invalid|PRIVATE_REASONING|INDEX_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(await listCodexSessions({ limit: 10 })), /aW1hZ2U=|image_url|DO_NOT_READ/, "sidebar metadata never carries image bytes");

  // Retain support for older event_msg layouts, without compacting before
  // memory-envelope removal or flattening markdown in the displayed reply.
  await fs.writeFile(file, [
    record(1, "session_meta", { id, cwd: tmp }),
    record(10, "event_msg", { type: "user_message", message: wrapped, images: [`data:${image.mediaType};base64,${image.data}`] }),
    record(11, "event_msg", { type: "agent_message", message: "# 旧回复\n\n正文" }),
  ].map(r => JSON.stringify(r)).join("\n"));
  const legacy = await getCodexSessionTurns(id);
  assert.equal(legacy[0].prompt, original);
  assert.deepEqual(legacy[0].images, [image], "older inline event_msg image layouts remain supported");
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
