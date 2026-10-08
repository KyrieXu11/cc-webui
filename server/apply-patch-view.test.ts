import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StepTimeline from "../src/components/StepTimeline.tsx";
import ApplyPatchDiff from "../src/components/ApplyPatchDiff.tsx";
import { sessionMessagesToEvents } from "../src/lib/processor.ts";
import type { ChatEvent } from "../src/lib/types.ts";

const changes = [{ file: "/project/README.md", type: "update", unified_diff: "@@ -393,1 +393,2 @@\n-old text\n+new text\n+<script>no executable HTML</script>" }];
const events = sessionMessagesToEvents([{ provider: "codex", prompt: "edit", startedAt: 1, events: [
  { type: "item.completed", item: { id: "p1", type: "file_change", status: "completed", changes } },
] }]);
const steps = events.filter((e): e is Extract<ChatEvent, { type: "step" }> => e.type === "step");
assert.equal(steps[0].tool, "ApplyPatch");
const html = renderToStaticMarkup(createElement(StepTimeline, { rows: steps, expandedIds: new Set([steps[0].id]), onToggle() {} }));
assert.match(html, /data-patch-diff/);
assert.match(html, /README\.md/);
assert.match(html, /data-diff-kind="del"/);
assert.match(html, /data-diff-kind="add"/);
assert.match(html, />393</);
assert.match(html, /新增 2 行，删除 1 行/);
assert.match(html, /原始工具数据/);
assert.doesNotMatch(html, /<script>/, "patch content is escaped, never rendered as HTML");
const failed = renderToStaticMarkup(createElement(ApplyPatchDiff, { changes, failed: true }));
assert.match(failed, /不代表全部修改已应用/);
const missing = renderToStaticMarkup(createElement(ApplyPatchDiff, { changes: [{ path: "binary.png", kind: "update" }] }));
assert.match(missing, /CLI 未提供具体差异/);
const large = renderToStaticMarkup(createElement(ApplyPatchDiff, { changes: [{ file: "large", type: "add", content: "line\n".repeat(601) }] }));
assert.equal((large.match(/data-diff-kind="add"/g) ?? []).length, 600);
assert.match(large, /显示全部 601 行/);
// Claude's existing Edit tool must retain its own renderer, not be rerouted.
const claude = renderToStaticMarkup(createElement(StepTimeline, { rows: [{ type: "step", id: "c", tool: "Edit", status: "ok", input: { file_path: "a.ts", old_string: "before", new_string: "after" } }], expandedIds: new Set(["c"]), onToggle() {} }));
assert.doesNotMatch(claude, /data-patch-diff/);
assert.doesNotMatch(claude, /old_string/, "Claude Edit still uses EditDiff, not the generic JSON view");
console.log("ApplyPatch timeline renders readable, escaped per-file diffs instead of JSON-only details");
