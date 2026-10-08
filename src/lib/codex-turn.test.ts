import assert from "node:assert/strict";
import { applySDKMessage, sessionMessagesToEvents } from "./processor.ts";
import type { ChatEvent } from "./types.ts";

const reply = (text: string) => ({ type: "item.completed", item: { id: "item_2", type: "agent_message", text } });
const user = (startedAt: number, prompt = "同一个问题") => ({ type: "turn_user", provider: "codex", startedAt, prompt });
const apply = (events: ChatEvent[], frame: unknown) => applySDKMessage(events, frame, () => {});

// Every exec process restarts item IDs: historical turns must not overwrite
// each other, and a later live reply must not overwrite a historical one.
let events = sessionMessagesToEvents([
  { provider: "codex", startedAt: 100, prompt: "同一个问题", events: [reply("第一轮回复")] },
  { provider: "codex", startedAt: 200, prompt: "同一个问题", events: [reply("第二轮回复")] },
]);
events = apply(events, user(300));
events = apply(events, reply("第三轮回复"));
assert.deepEqual(events.filter(e => e.type === "assistant").map(e => e.text), ["第一轮回复", "第二轮回复", "第三轮回复"]);
assert.equal(new Set(events.map(e => e.id)).size, events.length);

// Opening another user's live session supplies no browser-local ActiveTurn.
// Buffer replay itself must supply the question and a new turn boundary.
for (let i = 0; i < 2; i++) {
  events = apply(events, user(300));
  events = apply(events, reply("第三轮回复"));
}
assert.equal(events.filter(e => e.type === "user").length, 3, "repeated questions are not deduped by text");
assert.equal(events.filter(e => e.type === "assistant").length, 3, "attach replay is idempotent");

// A native rollout may already contain a partial live turn with different
// IDs and a later timestamp. Replace only that suffix before replaying.
events = sessionMessagesToEvents([
  { provider: "codex", startedAt: 100, prompt: "旧问题", events: [reply("旧回复")] },
  { provider: "codex", startedAt: 320, prompt: "新问题", events: [reply("部分新回复")] },
]);
events = apply(events, user(300, "新问题"));
events = apply(events, reply("完整新回复"));
assert.deepEqual(events.filter(e => e.type === "user").map(e => e.text), ["旧问题", "新问题"]);
assert.deepEqual(events.filter(e => e.type === "assistant").map(e => e.text), ["旧回复", "完整新回复"]);

// Own POST/refresh has a clientTurnId-based optimistic bubble. The server's
// clock differs, so match the explicit client ID, not its timestamp or prose.
events = [{ id: "u-my-client", type: "user", text: "" }];
const image = { mediaType: "image/png", data: "abc", name: "test.png" };
events = apply(events, { ...user(400, ""), clientTurnId: "my-client", images: [image] });
assert.equal(events.length, 1);
assert.equal(events[0].type, "user");
assert.deepEqual(events[0].type === "user" ? events[0].images : [], [image]);

// Native history includes the inline image, not its deleted CLI temp path.
// Images survive reopen, image-only requests, repeated prose and attach replay.
events = sessionMessagesToEvents([
  { provider: "codex", startedAt: 500, prompt: "同一个问题", images: [image], events: [reply("带图回复")] },
  { provider: "codex", startedAt: 600, prompt: "同一个问题", events: [reply("无图回复")] },
  { provider: "codex", startedAt: 700, prompt: "", images: [image], events: [] },
]);
const users = events.filter(e => e.type === "user");
assert.equal(users.length, 3, "image-only history is still a user bubble");
assert.deepEqual(users.map(e => e.images), [[image], undefined, [image]], "images never leak to the next identical question");
events = apply(events, { ...user(700, ""), images: [image] });
assert.equal(events.filter(e => e.type === "user").length, 3, "attach does not duplicate a restored image bubble");
const lastUser = events.at(-1);
assert.deepEqual(lastUser?.type === "user" ? lastUser.images : undefined, [image]);

console.log("Codex questions and per-turn item IDs survive history/attach replay");
