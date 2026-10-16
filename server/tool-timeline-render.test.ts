import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StepTimeline from "../src/components/StepTimeline.tsx";
import MessageList from "../src/components/MessageList.tsx";
import { toolExpansionIds, toolTimelineKey, type TimelineRow } from "../src/lib/tool-timeline.ts";
import type { ChatEvent } from "../src/lib/types.ts";

const rows: TimelineRow[] = [
  { id: "thought", type: "thinking", text: "", tokens: 1200 },
  { id: "s-read", type: "step", tool: "Read", status: "ok", arg: "completed.txt", output: "read detail" },
  { id: "s-patch", type: "step", tool: "ApplyPatch", status: "ok", input: { changes: [{ file: "a.ts", type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new" }] } },
  { id: "s-error", type: "step", tool: "Bash", status: "error", arg: "failed command", output: "failure detail" },
  { id: "s-live", type: "step", tool: "Bash", status: "pending", arg: "live command", elapsedSeconds: 30 },
];
const render = (expandedIds = new Set<string>()) => renderToStaticMarkup(createElement(StepTimeline, { rows, expandedIds, onToggle() {}, effort: "xhigh" }));
const collapsed = render();
assert.match(collapsed, /data-tool-summary="true" aria-expanded="false" aria-controls=/);
assert.match(collapsed, /已完成 2/); assert.doesNotMatch(collapsed, /失败 1/); assert.match(collapsed, /待完成 1/);
assert.match(collapsed, /思考 1 段/);
assert.match(collapsed, /tool-timeline-action[\s\S]*展开[\s\S]*详情/);
assert.match(collapsed, /tool-timeline-count/);
assert.doesNotMatch(collapsed.match(/<button type="button" data-tool-summary=[\s\S]*?<\/button>/)![0], /<button[^>]*>[\s\S]*<button/, "the action capsule is decorative content of a single accessible toggle, not a nested button");
assert.doesNotMatch(collapsed, /data-tool-step="s-read"|data-tool-step="s-patch"|data-patch-diff/);
assert.doesNotMatch(collapsed, /data-tool-step="s-error"|failed command/);
assert.match(collapsed, /data-tool-step="s-live" hidden=""/, "pending tools stay mounted but natively hidden to preserve their elapsed clock");
assert.match(collapsed, /data-timeline-row="thought" hidden=""/, "thinking folds with the tool history");
const expanded = render(new Set([toolTimelineKey("thought"), "s-patch"]));
assert.match(expanded, /data-tool-summary="true" aria-expanded="true"/);
assert.match(expanded, /data-tool-step="s-read"/); assert.match(expanded, /data-patch-diff/);
assert.match(expanded, /data-tool-step="s-error"/); assert.match(expanded, /data-tool-step="s-live"/);
assert.match(expanded, /tool-timeline-frame/); assert.match(expanded, /tool-timeline-content" data-expanded="true"/);
assert.doesNotMatch(expanded, /data-tool-step="s-live" hidden=/); assert.match(expanded, /30s/);
assert.match(expanded, /data-diff-kind="add"/); assert.match(expanded, /data-diff-kind="del"/);
assert.doesNotMatch(render(new Set(["s-error"])), /failure detail/, "individual detail state cannot punch through a collapsed group");
assert.match(render(new Set([toolTimelineKey("thought"), "s-error"])), /failure detail/, "expansion restores failure details");
const thinkingRow = (html: string) => html.match(/<div class="relative flex items-center py-\[6px\] gap-3 w-full text-left">.*?↓ 1\.2k tokens.*?<\/span><\/div><\/div>/)?.[0];
assert(thinkingRow(collapsed));
assert.equal(thinkingRow(collapsed), thinkingRow(expanded), "Claude thinking markup is unchanged by group disclosure");

const events: ChatEvent[] = [
  { id: "u", type: "user", text: "检查一下" },
  { id: "a1", type: "assistant", text: "我先检查这些文件。" },
  ...rows as ChatEvent[],
  { id: "permission", type: "permission", permissionId: "p", tool: "Bash", toolUseId: "live", input: { command: "live command" } },
  { id: "a2", type: "assistant", text: "检查后的结论。" },
  { id: "s-later-1", type: "step", tool: "Read", status: "ok" },
  { id: "s-later-2", type: "step", tool: "Read", status: "ok" },
];
const messages = (expandedSteps = new Set<string>(), provider: "claude" | "codex" = "claude") => renderToStaticMarkup(createElement(MessageList, {
  events, expandedSteps, onToggleStep() {}, onAnswerPermission() {}, provider, isRunning: true,
}));
const list = messages();
assert.equal((list.match(/data-tool-summary="true"/g) ?? []).length, 2, "assistant and permission boundaries remain separate, chronological groups");
assert.match(list, /我先检查这些文件/); assert.match(list, /检查后的结论/); assert.match(list, /检查一下/);
assert.match(list, /待审批 1/); assert.match(list, /允许本次/);
assert.match(list, /data-tool-step="s-live" hidden=""/, "approval's tool row folds while the independent approval card stays usable");
assert.match(list, /stroke-dasharray="3 2"/, "waiting permission stays a static circle, not an execution spinner");
assert.doesNotMatch(list, /completed.txt/);
assert.equal((messages(new Set(toolExpansionIds(events))).match(/data-tool-step=/g) ?? []).length, 6, "global expand reveals tools in every group");
assert.equal((messages(new Set([toolTimelineKey("thought")])).match(/data-tool-step=/g) ?? []).length, 4, "one group can be expanded independently");
const codexRows: TimelineRow[] = [...rows.slice(1, 3), { id: "live-reason", type: "thinking", text: "", status: "pending" }];
const codex = renderToStaticMarkup(createElement(StepTimeline, { rows: codexRows, expandedIds: new Set<string>(), onToggle() {}, liveThinkingIds: new Set(["live-reason"]), liveToolIds: new Set<string>(), effort: "xhigh" }));
assert.match(codex, /aria-label="Codex 思考中"/); assert.match(codex, /推理档位：xhigh/);
assert.doesNotMatch(codex, /data-tool-step=|处理中 ·|思考中 ·/);
assert.match(codex, /data-timeline-phase="reasoning"/);
assert.doesNotMatch(codex, /tool-timeline-label">思考中/, "the live thinking title is the original dynamic verb, not a repeated prefix");
const single = renderToStaticMarkup(createElement(StepTimeline, { rows: rows.slice(1, 2), expandedIds: new Set<string>(), onToggle() {} }));
assert.match(single, /data-tool-summary/); assert.doesNotMatch(single, /completed.txt/);
const activityOnly = renderToStaticMarkup(createElement(StepTimeline, {
  rows: [{ id: "live-codex-activity", type: "activity" }], expandedIds: new Set<string>(), onToggle() {},
}));
assert.match(activityOnly, /tool-timeline-frame/);
assert.match(activityOnly, /data-activity-only="true"/);
assert.match(activityOnly, /tool-timeline-activity/);
assert.match(activityOnly, /data-timeline-phase="processing"/);
assert.match(activityOnly, /aria-label="Codex 处理中"/);
assert.doesNotMatch(activityOnly, /data-tool-summary|aria-expanded|tool-timeline-action|工具 0|思考 0/, "a frame must not fabricate an empty history disclosure");
const afterReply = renderToStaticMarkup(createElement(MessageList, {
  events: [{ id: "u-activity", type: "user", text: "continue" }, { id: "a-activity", type: "assistant", text: "INTERMEDIATE REPLY" }],
  expandedSteps: new Set<string>(), onToggleStep() {}, onAnswerPermission() {}, provider: "codex", isRunning: true,
  turnStartedAt: Date.now() - 476000, effort: "xhigh",
}));
assert(afterReply.indexOf("INTERMEDIATE REPLY") < afterReply.indexOf('data-activity-only="true"'), "the activity frame stays after the reply, not merged into earlier records");
assert.match(afterReply, /tool-timeline-frame/);
assert.match(afterReply, /本轮总耗时/);
assert.doesNotMatch(activityOnly, /本轮总耗时/, "whole-turn timing remains outside the activity frame");
const stopped = renderToStaticMarkup(createElement(MessageList, {
  events: [{ id: "u-activity", type: "user", text: "continue" }], expandedSteps: new Set<string>(),
  onToggleStep() {}, onAnswerPermission() {}, provider: "codex", isRunning: false,
}));
assert.doesNotMatch(stopped, /data-activity-only|aria-label="Codex 处理中"/, "end/cancel does not leave an empty live frame");
const sequence: ChatEvent[] = [
  { id: "u-sequence", type: "user", text: "chronology" },
  { id: "call-before", type: "step", tool: "Read", status: "ok", output: "TOOL OUTPUT DETAIL" },
  { id: "output-between", type: "assistant", text: "INTERMEDIATE OUTPUT" },
  { id: "think-between", type: "thinking", text: "FIRST THINKING CONTENT", status: "ok" },
  { id: "call-after", type: "step", tool: "Bash", status: "ok" },
  { id: "think-after", type: "thinking", text: "", tokens: 420 },
  { id: "call-final", type: "step", tool: "Read", status: "pending" },
];
const ordered = renderToStaticMarkup(createElement(MessageList, { events: sequence, expandedSteps: new Set(toolExpansionIds(sequence)), onToggleStep() {}, onAnswerPermission() {}, provider: "claude" }));
const markers = ['data-tool-step="call-before"', 'TOOL OUTPUT DETAIL', 'INTERMEDIATE OUTPUT', 'data-timeline-row="think-between"', 'FIRST THINKING CONTENT', 'data-tool-step="call-after"', 'data-timeline-row="think-after"', 'data-tool-step="call-final"'];
const positions = markers.map(marker => ordered.indexOf(marker));
assert(positions.every(position => position >= 0));
assert.deepEqual([...positions].sort((a, b) => a - b), positions, "tool → output → thinking → tool → thinking → tool never becomes thinking-first");
const foldedSequence = renderToStaticMarkup(createElement(MessageList, { events: sequence, expandedSteps: new Set<string>(), onToggleStep() {}, onAnswerPermission() {}, provider: "claude", isRunning: true }));
assert.equal((foldedSequence.match(/data-tool-summary=/g) ?? []).length, 2, "output stays between independent chronological timeline segments");
assert(foldedSequence.indexOf('data-tool-summary=') < foldedSequence.indexOf('INTERMEDIATE OUTPUT'));
assert(foldedSequence.lastIndexOf('data-tool-summary=') > foldedSequence.indexOf('INTERMEDIATE OUTPUT'));
assert.match(foldedSequence, /data-timeline-phase="tools"/);
assert.match(foldedSequence, /tool-timeline-running/);
assert.match(foldedSequence, /Read 调用中，等待工具返回/);
assert.match(foldedSequence, /data-timeline-row="think-between" hidden=""/);
const oldApproval = renderToStaticMarkup(createElement(MessageList, { events: events.map(ev => ev.type === "permission" ? { ...ev, stale: true } : ev), expandedSteps: new Set<string>(), onToggleStep() {}, onAnswerPermission() {}, provider: "claude" }));
assert.doesNotMatch(oldApproval, /data-timeline-phase="approval"|待审批 1/, "stale history cannot claim a live approval phase");
console.log("Tool timeline rendering: collapsed/expanded, independent groups, diff, permissions, replies, Claude thinking and Codex liveness verified");
