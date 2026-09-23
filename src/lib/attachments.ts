// 输入框把非图片附件写进消息正文的那一段（Composer.tsx 的提交处）：
//
//   附件：
//   - <path>  (<name>)
//   - …
//
//   <正文>
//
// agent 要靠路径才能去读文件，所以**发出去的正文必须带着它**；但气泡里不该把
// 临时目录的全路径亮给人看（用户 2026-09-23：「这个附件怎么会显示路径全文」）。
// 这里只负责把那一段认出来，渲染成文件名卡片是 UserBubble 的事。
//
// 认不出（格式和 Composer 写的对不上）就原样返回：宁可多显示，也不吞掉内容。
// ⚠️ 改 Composer 那边的格式时这里要一起改，user-defaults 同款的「两头一张表」。

export type InlineAttachment = { path: string; name: string };

const HEAD = "附件：\n";
// 路径和名字之间是**两个**空格（Composer 写的是 `- ${path}  (${name})`）。
// 路径那组是贪婪的，所以名字里自带括号（「笔记 (1).pdf」）也分得对。
const LINE = /^- (.+) {2}\((.+)\)$/;

export function splitAttachments(text: string): {
  files: InlineAttachment[];
  body: string;
} {
  if (!text.startsWith(HEAD)) return { files: [], body: text };
  const lines = text.slice(HEAD.length).split("\n");
  const files: InlineAttachment[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = LINE.exec(lines[i]);
    if (!m) break;
    files.push({ path: m[1], name: m[2] });
  }
  if (files.length === 0) return { files: [], body: text };
  // 列表后面要么什么都没有（只发了附件），要么一个空行再接正文。别的形状不认。
  const rest = lines.slice(i);
  if (rest.length > 0 && rest[0] !== "") return { files: [], body: text };
  return { files, body: rest.slice(1).join("\n") };
}
