import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { downloadFiles } from "./files.ts";

// 保留浏览器原生流式下载，不 fetch/blob；文件夹沿用同一入口，无须预先展开树。
let clicked = false;
let appended = false;
let removed = false;
const anchor = {
  href: "", download: "not set", rel: "", style: { display: "" },
  click: () => { clicked = true; },
  remove: () => { removed = true; },
};
const original = Object.getOwnPropertyDescriptor(globalThis, "document");
try {
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => { assert.equal(tag, "a"); return anchor; },
    body: { appendChild: (node: unknown) => { assert.equal(node, anchor); appended = true; } },
  } });
  downloadFiles([]);
  assert.equal(clicked, false);
  downloadFiles(["/project/练习册", "/project/说明 & 附件.txt"]);
  const url = new URL(anchor.href, "http://localhost");
  assert.deepEqual(url.searchParams.getAll("path"), ["/project/练习册", "/project/说明 & 附件.txt"]);
  assert.equal(anchor.download, "", "错误响应也不能导航走当前工作台");
  assert(clicked && appended && removed);
} finally {
  if (original) Object.defineProperty(globalThis, "document", original);
  else Reflect.deleteProperty(globalThis, "document");
}

const source = readFileSync(new URL("../components/FileExplorer.tsx", import.meta.url), "utf8");
const button = source.slice(source.lastIndexOf("<button", source.indexOf("downloadFiles([...picked.keys()])")), source.indexOf("下载 {picked.size}"));
assert.match(button, /disabled=\{picked.size === 0\}/, "文件夹选中后下载不能灰掉");
assert.doesNotMatch(button, /disabled=\{[^}]*pickedHasDir/);
assert.match(button, /保留文件夹结构/);
console.log("Download UI: folders enabled, repeated query encoding and native browser download preserved");
