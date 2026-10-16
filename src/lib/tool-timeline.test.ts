import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { summarizeToolTimeline, toolTimelineKey, toolExpansionIds, visibleTimelineRows, mountedTimelineRows, timelinePhase, type TimelineRow } from "./tool-timeline.ts";
import type { ChatEvent } from "./types";

const step = (id: string, status: "ok" | "pending" | "error" = "ok"): TimelineRow => ({ id, type: "step", tool: "Bash", status });
const thinking: TimelineRow = { id: "thinking", type: "thinking", text: "", tokens: 1200 };
const activity: TimelineRow = { id: "activity", type: "activity" };
const rows = [thinking, step("done-1"), step("done-2"), step("failed", "error"), step("running", "pending"), step("permission", "pending"), activity];
const awaiting = new Set(["permission"]);
const summary = summarizeToolTimeline(rows, awaiting);
assert.deepEqual(summary, { total: 5, completed: 2, failed: 1, pending: 1, awaiting: 1, thinking: 1, collapsible: true, key: toolTimelineKey("thinking") });
assert.deepEqual(visibleTimelineRows(rows, false), [], "all tool and thinking history folds, not just successful tools");
assert.strictEqual(visibleTimelineRows(rows, true), rows, "expansion restores original order without thinking-first sorting");
assert.deepEqual(mountedTimelineRows(rows, false).map(r => r.id), ["thinking", "running", "permission", "activity"]);
assert.strictEqual(mountedTimelineRows(rows, false)[0], thinking, "preserve the thinking component and its own clock while hidden");
assert.strictEqual(mountedTimelineRows(rows, false)[1], rows[4], "preserve the hidden pending tool's clock");
assert.strictEqual(mountedTimelineRows(rows, true), rows);
assert.equal(summarizeToolTimeline([step("one")]).collapsible, true);
assert.equal(summarizeToolTimeline([thinking]).collapsible, true, "a thinking-only segment belongs in the timeline too");
assert.equal(summarizeToolTimeline([activity]).collapsible, false, "generic liveness with no recorded history remains a simple activity row");
assert.equal(summarizeToolTimeline([...rows, step("streamed")]).key, summary.key, "appending tools cannot reset a thinking-first timeline's expansion key");
assert.equal(summarizeToolTimeline([thinking, step("first")]).key, summarizeToolTimeline([thinking]).key);
assert.deepEqual(summarizeToolTimeline([]), { total: 0, completed: 0, failed: 0, pending: 0, awaiting: 0, thinking: 0, collapsible: false, key: undefined });
const finished = rows.map(row => row.id === "running" && row.type === "step" ? { ...row, status: "ok" as const } : row);
assert(!mountedTimelineRows(finished, false).some(row => row.id === "running"));
assert(visibleTimelineRows(finished, true).some(row => row.id === "running"));
const large = Array.from({ length: 1500 }, (_, i) => step(`s-${i}`));
assert.equal(summarizeToolTimeline(large).total, 1500);
assert.equal(mountedTimelineRows(large, false).length, 0, "no massive hidden history DOM");
assert.equal(visibleTimelineRows(large, true).length, 1500);
assert.equal(rows.length, 7, "canonical events are not mutated");
const events: ChatEvent[] = [
  { id: "user", type: "user", text: "hello" },
  { id: "t", type: "thinking", text: "reasoning" },
  { id: "s-1", type: "step", tool: "Read", status: "ok" },
  { id: "s-2", type: "step", tool: "ApplyPatch", status: "ok" },
];
assert.deepEqual(toolExpansionIds(events), ["t", toolTimelineKey("t"), "s-1", toolTimelineKey("s-1"), "s-2", toolTimelineKey("s-2")]);
assert.notEqual(toolTimelineKey("s-1"), "s-1");
assert.deepEqual(timelinePhase(rows, { executingIds: new Set(["running"]) }), { phase: "tools" });
assert.deepEqual(timelinePhase(rows, { awaitingPermission: awaiting }), { phase: "approval" });
assert.deepEqual(timelinePhase([step("old", "pending")], {}), { phase: "idle" }, "historical unfinished tools are not currently executing");
assert.deepEqual(timelinePhase([thinking], { liveThinkingIds: new Set(["thinking"]) }), { phase: "reasoning", rowId: "thinking" });
assert.deepEqual(timelinePhase([thinking], { thinkingCandidateId: "thinking", observedThinkingIds: new Set(["thinking"]) }), { phase: "reasoning", rowId: "thinking" });
assert.deepEqual(timelinePhase([thinking], { thinkingCandidateId: "thinking", observedThinkingIds: new Set() }), { phase: "idle" }, "Claude must preserve its existing token/text activity detection");
assert.deepEqual(timelinePhase([thinking], { observedThinkingIds: new Set(["thinking"]) }), { phase: "idle" }, "a historical thinking row cannot take over a current turn's header");
assert.deepEqual(timelinePhase([thinking, activity], { liveThinkingIds: new Set(), thinkingCandidateId: "thinking", observedThinkingIds: new Set(["thinking"]) }), { phase: "processing", rowId: "activity" }, "Codex unknown waiting is never fabricated reasoning");
const chronological = [step("call-1"), thinking, step("call-2"), { ...thinking, id: "next-thought" }, step("call-3")];
assert.deepEqual(visibleTimelineRows(chronological, true).map(row => row.id), ["call-1", "thinking", "call-2", "next-thought", "call-3"]);
const css = readFileSync(new URL("../liquid-glass.css", import.meta.url), "utf8");
const toggle = css.match(/\.tool-timeline-toggle\s*\{([^}]+)\}/)![1]!;
const frame = css.match(/\.tool-timeline-frame\s*\{([^}]+)\}/)![1]!;
assert.match(toggle, /min-height:\s*48px/);
assert.match(frame, /border:\s*1px solid var\(--color-line\)/);
assert.match(frame, /background:\s*var\(--color-surface-2\)/);
assert.doesNotMatch(toggle, /(?:backdrop-filter|\bfilter|\btransform|\bcontain)\s*:/, "only the summary gains a stable control surface, not filters or animation hosts");
assert.match(css, /\.tool-timeline-label\s*\{[^}]*font-size:\s*14px[^}]*font-weight:\s*600/);
assert.match(css, /\.tool-timeline-action\s*\{[^}]*color:\s*var\(--color-blue\)/);
assert.match(css, /\.tool-timeline-frame, \.tool-timeline-toggle, \.tool-timeline-chevron svg, \.tool-timeline-action-chevron\s*\{\s*transition:\s*none/);
assert.match(toggle, /grid-template-columns:\s*24px minmax\(0, 1fr\) auto/, "the action cannot fall below the live status");
assert.match(css, /\.tool-timeline-content\[data-expanded="true"\]\s*\{[^}]*background:\s*var\(--color-surface\)/, "execution steps stay in the same framed group on an opaque surface");
console.log("Unified timeline: ordered thinking/tools, stable expansion, retained clocks, strict phase signals, history and Ctrl+O verified");
