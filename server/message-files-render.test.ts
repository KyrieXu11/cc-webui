import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../src/components/Markdown.tsx";
import MessageList from "../src/components/MessageList.tsx";
import type { ChatEvent } from "../src/lib/types.ts";

const cwd = "/work/project";
const source = "已保存到 `成品/练习.docx`。\n\n[PDF](</work/报告 final.pdf>)、[旧文件](file:///work/guide.md)、[源码](src/App.tsx#L42)。\n\n[参考][guide]\n\n[guide]: docs/guide.md\n\n[网页里的 `src/App.tsx`](https://example.com)\n\n```\n成品/练习.docx\n```\n\n```md\n[样例](example.md)\n```\n\n`python scripts/build.py`、`https://example.com/report.pdf`、`npm run build.ts`\n\n[危险](javascript:alert(1))\n\n<script>alert(1)</script>";
const render = (fileCwd?: string) => renderToStaticMarkup(createElement(Markdown, { text: source, fileCwd }));
const html = render(cwd);
assert.equal((html.match(/data-message-file-path=/g) ?? []).length, 5);
assert.match(html, /<button[^>]*data-message-file-path="\/work\/project\/成品\/练习.docx"[^>]*><code/);
assert.match(html, /data-message-file-path="\/work\/报告 final.pdf"/);
assert.match(html, /data-message-file-path="\/work\/guide.md"/);
assert.match(html, /data-message-file-path="\/work\/project\/src\/App.tsx"/);
assert.match(html, /data-message-file-path="\/work\/project\/docs\/guide.md"/);
assert.doesNotMatch(html, /href="(?:file:|javascript:|\/work|docs\/|src\/)/, "file actions are buttons, not browser navigation/download links");
assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
assert.doesNotMatch(html, /<a[^>]*>[\s\S]*?<button[\s\S]*?<\/a>/, "inline code inside web links never creates nested actions");
assert.doesNotMatch(html.match(/<pre[\s\S]*?<\/pre>/g)?.join("") ?? "", /<button|data-message-file-path/);
assert.doesNotMatch(html, /<script>/);
assert.doesNotMatch(render(), /data-message-file-path=|<button/, "memory and file previews keep ordinary Markdown behavior");

const events: ChatEvent[] = [
  { id: "u", type: "user", text: "查看 `成品/练习.docx`" },
  { id: "a", type: "assistant", text: "已保存到 `成品/练习.docx`。" },
];
const messages = (provider: "claude" | "codex", project?: string) => renderToStaticMarkup(createElement(MessageList, {
  events, provider, cwd: project, expandedSteps: new Set<string>(), onToggleStep() {}, onAnswerPermission() {},
}));
assert.equal((messages("codex", cwd).match(/data-message-file-path=/g) ?? []).length, 1, "only the Codex assistant reply has file actions, not the user bubble");
assert.doesNotMatch(messages("claude", cwd), /data-message-file-path=/, "Claude rendering remains unchanged");
assert.doesNotMatch(messages("codex"), /data-message-file-path=/, "group chats without webpage cwd do not acquire file actions");
const renderPaths = (text: string) => [...renderToStaticMarkup(createElement(Markdown, { text, fileCwd: cwd })).matchAll(/data-message-file-path="([^"]+)"/g)].map(match => match[1]);
assert.deepEqual(renderPaths("已制作并检查，保存到 `成品/必修一/Unit 2/练习册/`：\n\n- `课时2-阅读理解.html`\n- `课时2-七选五.html`\n- `课时2-语法填空.html`\n\n页面标题与文件名一致。\n\n另一个文件：`README.md`"), [
  `${cwd}/成品/必修一/Unit 2/练习册/课时2-阅读理解.html`,
  `${cwd}/成品/必修一/Unit 2/练习册/课时2-七选五.html`,
  `${cwd}/成品/必修一/Unit 2/练习册/课时2-语法填空.html`,
  `${cwd}/README.md`,
], "regression: a declared directory + bare-name list must not open cwd/filename and 404");
assert.deepEqual(renderPaths("保存到 `output/`:\n\n1. [PDF](a.pdf)\n2. `output/b.md`\n3. [绝对路径](/work/project/c.md)"), [`${cwd}/output/a.pdf`, `${cwd}/output/b.md`, `${cwd}/c.md`]);
for (const prefix of ["保存到 `one/` 或 `two/`：", "网页 [目录](https://example.com/)：", "代码目录 `output/`。", "保存到 `output/`：\n\n下面是另一段说明。", "```\n保存到 output/:\n```", "目录在 `output/`，这里的示例 `README.md`："]) {
  assert.equal(renderPaths(prefix + "\n\n- `a.md`").at(-1), `${cwd}/a.md`, "ambiguous, non-colon, unrelated paragraph, code or web-link directories cannot redirect a file list");
}
console.log("Codex file actions: inline code, legacy links and references, safe web links and isolated Markdown rendering verified");
