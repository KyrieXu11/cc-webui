import assert from "node:assert/strict";
import { resolveMessageDirectory, resolveMessageFile } from "./message-files.ts";
import { onDockOpen, openInDock, type DockFile } from "./dock-bridge.ts";

const cwd = "/work/project";
const file = (value: string, source: "code" | "link" = "code") => resolveMessageFile(value, cwd, source);
assert.deepEqual(file("成品/练习.docx"), { path: `${cwd}/成品/练习.docx`, name: "练习.docx" });
assert.deepEqual(file("/work/我的项目/report final.pdf"), { path: "/work/我的项目/report final.pdf", name: "report final.pdf" });
assert.equal(file("./成品/Unit 1 练习.docx")?.path, `${cwd}/成品/Unit 1 练习.docx`);
assert.equal(file("成品/Unit 1 练习.docx")?.path, `${cwd}/成品/Unit 1 练习.docx`);
assert.equal(file("README.md")?.path, `${cwd}/README.md`);
assert.equal(file(".env")?.name, ".env");
assert.equal(file("Dockerfile")?.name, "Dockerfile");
assert.equal(file("src/App.tsx:42:3")?.path, `${cwd}/src/App.tsx`);
assert.equal(file("src/App.tsx#L42-L55")?.path, `${cwd}/src/App.tsx`);
assert.equal(file("src/App.tsx#L42C3-L55C7")?.path, `${cwd}/src/App.tsx`);
assert.equal(file("../shared/guide.md")?.path, `${cwd}/../shared/guide.md`, "server resolves parents and symlinks before authorization");
assert.equal(file("/work/link/../guide.md")?.path, "/work/link/../guide.md");
assert.equal(file("file:///work/%E6%88%90%E5%93%81/report%20final.pdf", "link")?.path, "/work/成品/report final.pdf");
assert.equal(file("file://localhost/work/guide.md#L2", "link")?.path, "/work/guide.md");
assert.equal(file("report%20final.docx", "link")?.path, `${cwd}/report final.docx`);
assert.equal(file("report%2520final.docx", "link")?.path, `${cwd}/report%20final.docx`, "decode link destinations exactly once");
assert.equal(file("report%20final.docx")?.path, `${cwd}/report%20final.docx`, "literal code paths are not URL-decoded");
for (const source of ["code", "link"] as const) {
  for (const value of ["https://example.com/report.pdf", "//example.com/report.pdf", "www.example.com", "javascript:alert(1)", "data:text/html,x", "sandbox:/mnt/data/report.pdf", "#heading", "/api/fs/read", "/api/fs/raw?path=/work/a.pdf", "~/a.md", "C:\\work\\a.md", "成品/", "/work/project", "src/*.ts", "version-1.2.3", "a.md\n", "a.md\0"]) {
    assert.equal(file(value, source), null, `${source}: must not treat ${JSON.stringify(value)} as a file action`);
  }
}
// Explicit destinations may have spaces; commands are excluded only in code.
assert.equal(file("python scripts/build.py"), null);
assert.equal(file("npm run build.ts"), null);
assert.equal(file("python scripts/build.py", "link")?.path, `${cwd}/python scripts/build.py`);
for (const value of ["file://remote/work/a.pdf", "file:///work/a.pdf?download=1", "%2f%2fevil/a.pdf", "javascript%3aalert(1)", "file:///work/a%00.pdf", "bad%GG.pdf"]) {
  assert.equal(file(value, "link"), null);
}
assert.equal(resolveMessageFile("a.md", ""), null);
assert.equal(resolveMessageFile("a.md", "relative/project"), null);
assert.equal(resolveMessageFile("a.md", "//remote/project"), null);
assert.equal(resolveMessageFile("a.md", "/")?.path, "/a.md");
const directory = resolveMessageDirectory("成品/必修一/Unit 2/练习册/", cwd)!;
assert.equal(directory, `${cwd}/成品/必修一/Unit 2/练习册`);
assert.equal(resolveMessageFile("课时2-阅读理解.html", cwd, "code", directory)?.path, `${directory}/课时2-阅读理解.html`);
assert.equal(resolveMessageFile("成品/课时2-阅读理解.html", cwd, "code", directory)?.path, `${cwd}/成品/课时2-阅读理解.html`, "a full relative path stays project-relative, never double-prefixed");
assert.equal(resolveMessageFile("/other/a.md", cwd, "code", directory)?.path, "/other/a.md");
assert.equal(resolveMessageFile("file:///work/project/a.md", cwd, "link", directory)?.path, `${cwd}/a.md`, "absolute file URLs are never rebased");
assert.equal(resolveMessageFile("report%20final.docx", cwd, "link", directory)?.path, `${directory}/report final.docx`);
for (const value of ["https://example.com/", "sandbox:/mnt/data/", "python scripts/", "dir", "dir/\n", "//remote/", "~/output/", "/api/fs/"]) assert.equal(resolveMessageDirectory(value, cwd), null);
assert.equal(resolveMessageDirectory("/work/report folder/", cwd), "/work/report folder");
assert.equal(resolveMessageDirectory("./", cwd), cwd);
assert.equal(resolveMessageDirectory("/", cwd), "/");
assert.equal(resolveMessageFile("a.md", cwd, "code", "https://example.com"), null);

const seen: DockFile[] = [];
const stop = onDockOpen(f => seen.push(f));
const resolved = file("成品/练习.docx")!;
openInDock(resolved);
assert.deepEqual(seen, [resolved]);
stop();
openInDock(resolved);
assert.equal(seen.length, 1, "existing dock bridge cleans up its subscription");
console.log("Message file paths: project/absolute/encoded references, line suffixes and non-file boundaries verified");
