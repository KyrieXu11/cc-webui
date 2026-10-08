import assert from "node:assert/strict";
import { applySDKMessage, sessionMessagesToEvents } from "./processor.ts";
import { activityLabel, codexActivityLabel, formatActivityElapsed, formatTurnElapsed, liveThinkingIds, liveToolIds, showCodexActivity, turnElapsedSeconds } from "./turn-activity.ts";
import type { ChatEvent } from "./types.ts";

// Animated words are decorative status feedback, not measured reasoning.
// Keep only the designed verb visible; aria/title carry phase semantics in the
// component, and total elapsed time lives in a separate statistic.
for (const word of ["Decoding", "Whirring", "Tinkering"]) {
  assert.equal(activityLabel(true, word, true), `${word}…`, "legacy Claude presentation remains unchanged");
  assert.equal(codexActivityLabel(true, word, "processing"), `${word}…`);
  assert.equal(codexActivityLabel(true, word, "reasoning"), `${word}…`);
}
assert.equal(formatActivityElapsed(14 * 60 + 35, true), "回合已用 14m35s");
assert.equal(formatActivityElapsed(0, true), "回合已用 0s");
assert.equal(formatActivityElapsed(59, true), "回合已用 59s");
assert.equal(formatActivityElapsed(60, true), "回合已用 1m00s");
assert.equal(formatActivityElapsed(61, true), "回合已用 1m01s");
assert.equal(formatTurnElapsed(311), "本轮总耗时 5m11s");
assert.equal(codexActivityLabel(false, "Whirring", "reasoning"), "thought");
assert.equal(codexActivityLabel(false, "Whirring", "processing"), "已结束");
assert.equal(turnElapsedSeconds(1000, 312000), 311, "attach/remount uses the original server turn start");
assert.equal(turnElapsedSeconds(undefined, 312000), null, "unknown start time must not become a mount-time counter");
assert.equal(turnElapsedSeconds(NaN, 312000), null);
assert.equal(turnElapsedSeconds(1000, Infinity), null);
assert.equal(turnElapsedSeconds(2000, 1000), 0, "small server/client clock skew never shows negative time");
assert.equal(activityLabel(true, "Decoding"), "Decoding…", "Claude keeps its own token-activity label");
assert.equal(activityLabel(false, "Decoding"), "thought");
assert.equal(formatActivityElapsed(875), "14m35s");
assert.equal(activityLabel(true, "Decoding", false), "Decoding…", "real reasoning retains the designed animation label");

let reasoning: ChatEvent[] = [{ id: "reason-u", type: "user", text: "test" }];
const reasoningItem = { id: "reason", type: "reasoning", text: "" };
reasoning = applySDKMessage(reasoning, { type: "item.started", item: reasoningItem }, () => {});
assert.equal(liveThinkingIds(reasoning, true).size, 1, "explicit reasoning start counts even without public text");
assert.equal(showCodexActivity(reasoning, true), false, "real reasoning replaces generic processing");
assert.equal(liveThinkingIds(reasoning, false).size, 0, "history/cancel is never live reasoning");
reasoning = applySDKMessage(reasoning, { type: "item.started", item: { id: "tool", type: "command_execution", command: "echo ok" } }, () => {});
assert.equal(liveThinkingIds(reasoning, true).size, 0, "tool execution does not animate a thinking row");
assert.equal(showCodexActivity(reasoning, true), false);
reasoning = applySDKMessage(reasoning, { type: "item.completed", item: { id: "tool", type: "command_execution", command: "echo ok" } }, () => {});
assert.equal(liveThinkingIds(reasoning, true).size, 0, "tool completion cannot revive old reasoning");
assert.equal(showCodexActivity(reasoning, true), true, "without a new reasoning signal only processing is known");
reasoning = applySDKMessage(reasoning, { type: "item.started", item: { ...reasoningItem, id: "next-reason" } }, () => {});
assert.equal(liveThinkingIds(reasoning, true).size, 1, "a new reasoning stage restores the designed animation");
reasoning = applySDKMessage(reasoning, { type: "item.completed", item: { ...reasoningItem, id: "next-reason", text: "public summary" } }, () => {});
assert.equal(liveThinkingIds(reasoning, true).size, 0, "a completed reasoning summary is not live thinking");
assert.equal(showCodexActivity(reasoning, true), true);
reasoning = applySDKMessage(reasoning, { type: "item.started", item: { ...reasoningItem, id: "final-reason" } }, () => {});
assert.equal(liveThinkingIds(reasoning, true).size, 1);
reasoning = applySDKMessage(reasoning, { type: "item.started", item: { id: "answer", type: "agent_message", text: "" } }, () => {});
assert.equal(liveThinkingIds(reasoning, true).size, 0, "answer generation also ends the reasoning phase, even before text arrives");
assert.equal(showCodexActivity(reasoning, true), true);

let events: ChatEvent[] = [{ id: "u", type: "user", text: "列出记忆" }];
const emit = (phase: string, item: unknown) => { events = applySDKMessage(events, { type: phase, item }, () => {}); };
assert.equal(showCodexActivity(events, true), true, "quiet time before first output stays active");
emit("item.started", { id: "memory", type: "mcp_tool_call", server: "memory", tool: "list", arguments: {}, status: "in_progress" });
assert.equal(showCodexActivity(events, true), false, "tool spinner replaces turn activity");
assert.deepEqual([...liveToolIds(events, true)], ["s-codex-u-memory"]);
emit("item.completed", { id: "memory", type: "mcp_tool_call", server: "memory", tool: "list", arguments: {}, status: "completed", result: { content: [{ type: "text", text: '{"total":22}' }] } });
assert.equal(events.filter(e => e.type === "step").length, 1, "completion updates the same tool row");
assert.equal(showCodexActivity(events, true), true, "turn activity resumes after the tool, without inventing reasoning events");
assert.match((events[1] as Extract<ChatEvent,{type:"step"}>).output!, /22/);
assert.equal(showCodexActivity(events, false), false, "done/cancel/disconnect stops the spinner");
assert.deepEqual([...liveToolIds(events, false)], []);
emit("item.started", { id: "search", type: "web_search", query: "test" });
assert.equal((events[2] as Extract<ChatEvent,{type:"step"}>).status, "pending");
emit("item.completed", { id: "search", type: "web_search", query: "test" });
assert.equal((events[2] as Extract<ChatEvent,{type:"step"}>).status, "ok");
emit("item.completed", { id: "bad", type: "mcp_tool_call", server: "memory", tool: "save", status: "completed", result: { isError: true, content: [{ type: "text", text: "read_only" }] } });
assert.equal((events[3] as Extract<ChatEvent,{type:"step"}>).status, "error", "MCP business errors are not green successes");
emit("item.completed", { id: "reason", type: "reasoning", text: "A public reasoning summary" });
assert.equal((events[4] as Extract<ChatEvent,{type:"thinking"}>).status, "ok");
events.push({ id:"old",type:"step",tool:"CodexShell",status:"pending" }, { id:"new-u",type:"user",text:"another turn" });
assert.equal(showCodexActivity(events, true), true, "an unfinished historic tool cannot suppress the next turn");
assert.deepEqual([...liveToolIds(events, true)], []);
const history = sessionMessagesToEvents([{ provider:"codex",prompt:"test",startedAt:1,events:[{type:"item.completed",item:{id:"m",type:"mcp_tool_call",server:"memory",tool:"list",status:"completed",result:{content:[]}}}] }]);
assert.equal(showCodexActivity(history, false), false);
const waiting: ChatEvent[] = [{id:"s-call",type:"step",tool:"Bash",status:"pending"},{id:"p",type:"permission",permissionId:"p",tool:"Bash",input:{},toolUseId:"call"}];
assert.equal(showCodexActivity(waiting, true), false);
assert.deepEqual([...liveToolIds(waiting, true)], [], "approval wait is not tool execution");
