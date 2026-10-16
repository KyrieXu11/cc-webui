import assert from "node:assert/strict";
import { fileTreeTarget } from "./tree-reveal.ts";

assert.deepEqual(fileTreeTarget("/project", "/project/成品/强调整理/投屏版.pptx"), {
  path: "/project/成品/强调整理/投屏版.pptx",
  directories: ["/project/成品", "/project/成品/强调整理"],
});
assert.deepEqual(fileTreeTarget("/project/", "/project//成品/./report.md"), {
  path: "/project/成品/report.md", directories: ["/project/成品"],
});
assert.deepEqual(fileTreeTarget("/project", "/project/README.md"), { path: "/project/README.md", directories: [] });
assert.deepEqual(fileTreeTarget("/", "/docs/report.md"), { path: "/docs/report.md", directories: ["/docs"] });
for (const file of [null, undefined, "", "/other/report.md", "/project-other/report.md", "/project", "/project/", "report.md", "//project/report.md", "/project/a/../report.md", "/project/../other/report.md", "/project/a\0.md", "file:///project/report.md"]) {
  assert.equal(fileTreeTarget("/project", file), null, `Do not falsely reveal ${JSON.stringify(file)} in this project`);
}
assert.equal(fileTreeTarget("relative/project", "/project/a.md"), null);
assert.equal(fileTreeTarget("/project/../other", "/other/a.md"), null);
console.log("File tree reveal: ancestor chain, root files, Unicode and outside/ambiguous path boundaries verified");
