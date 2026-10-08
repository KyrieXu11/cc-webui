import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../src/components/Markdown.tsx";
import { WEB_OUTPUT_RULES } from "./web-output-rules.ts";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

// 2026-10-08 的真实问题形状：不是前端丢字，而是模型输出了不兼容的强调边界。
// 不改解析器；规范里的正例必须在当前唯一的 Markdown 渲染器上确实能渲染。
const broken = "- **how to do：如何做某事。**这里用 ______ 形式。";
assert.doesNotMatch(render(broken), /<strong\b/);
for (const example of [
  "**how to do**：如何做某事。这里用 ______ 形式。",
  "**38题**：谓语是…",
]) {
  assert.ok(WEB_OUTPUT_RULES.includes(example), "test the examples actually injected into the model");
  const html = render(example);
  assert.match(html, /<strong\b/);
  assert.doesNotMatch(html, /\*\*/);
}

const fileExample = "已保存到 `成品/语法填空/做题方法.docx`。";
assert.ok(WEB_OUTPUT_RULES.includes(fileExample));
assert.match(render(fileExample), /<code\b/);
assert.doesNotMatch(render(fileExample), /<a\b/, "a disk location is not a delivery URL");
assert.match(WEB_OUTPUT_RULES, /Do not emit Markdown links to server-local files/);
assert.match(WEB_OUTPUT_RULES, /Do not invent website paths, API URLs/);
assert.match(WEB_OUTPUT_RULES, /Ordinary external web links remain allowed/);
assert.match(WEB_OUTPUT_RULES, /:codex-followup/);
assert.match(WEB_OUTPUT_RULES, /adapt their final-response UI conventions to this host even when a skill requests an exact widget syntax/);
assert.match(WEB_OUTPUT_RULES, /ordinary prose or Markdown list items/);
assert.match(WEB_OUTPUT_RULES, /not to verbatim quotations, code/);
console.log("web output rule examples render without inventing download links");
