import assert from "node:assert/strict";
import { parseUnifiedDiff, patchChanges } from "./patch-diff.ts";

const diff = "--- a/a.ts\r\n+++ b/a.ts\r\n@@ -39,3 +39,4 @@ fn\r\n keep\r\n-old\r\n+new\r\n+extra\r\n last\r\n\\ No newline at end of file\r\n";
const parsed = parseUnifiedDiff(diff);
assert.equal(parsed.added, 2);
assert.equal(parsed.removed, 1);
assert.deepEqual(parsed.lines.filter(l => l.kind === "context" || l.kind === "add" || l.kind === "del"), [
  { kind: "context", text: "keep", oldLine: 39, newLine: 39 },
  { kind: "del", text: "old", oldLine: 40 },
  { kind: "add", text: "new", newLine: 40 },
  { kind: "add", text: "extra", newLine: 41 },
  { kind: "context", text: "last", oldLine: 41, newLine: 42 },
]);
assert.equal(parseUnifiedDiff("@@ -0,0 +1,1 @@\n+++literal plus\n").lines[1].text, "++literal plus", "file header-like code inside a hunk remains an addition");
const multiple = parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -5 +5 @@\n-x\n+y");
assert.equal(multiple.added, 2); assert.equal(multiple.removed, 2);
assert.equal(multiple.lines.at(-1)?.newLine, 5);
assert.deepEqual(patchChanges(undefined), []);
const changes = patchChanges([
  { file: "原文件.md", type: "update", unified_diff: diff, move_path: "新位置.md" },
  { path: "create.txt", kind: { type: "add", content: "一\n\n二\n" } },
  { file: "empty.txt", type: "add", content: "" },
  { file: "gone.txt", type: "delete", content: "old\n" },
  { path: "no-data.txt", kind: "update" },
]);
assert.equal(changes[0].moveTo, "新位置.md");
assert.equal(changes[1].added, 3);
assert.equal(changes[2].added, 0, "empty files are not reported as one added line");
assert.equal(changes[3].removed, 1);
assert.equal(changes[4].hasDiff, false, "no invented historical diff or counts");
assert.equal(changes[1].lines[0].newLine, undefined, "no invented line numbers without a hunk");
console.log("patch-diff: native/stream shapes, line numbers, counts and missing data verified");
