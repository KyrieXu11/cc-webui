// 气泡里的附件只显示文件名（用户 2026-09-23）。发给 agent 的正文不变，
// 这里钉住的是「认得出 Composer 写的那一段，认不出就原样返回」。

import assert from "node:assert/strict";
import { splitAttachments } from "./attachments.ts";

const P =
  "/var/folders/48/pthhcnnd4nqd6cy_216kypsc0000gn/T/cc-webui-uploads/mudvawzh-FREE高考英语零基础入门训练笔记2.pdf";

// 用户截图里那一条，原样
let r = splitAttachments(
  `附件：\n- ${P}  (FREE高考英语零基础入门训练笔记2.pdf)\n\n我想做一个语法专题，从最基础的语法讲起。\n第二行`,
);
assert.deepEqual(r.files, [{ path: P, name: "FREE高考英语零基础入门训练笔记2.pdf" }]);
assert.equal(r.body, "我想做一个语法专题，从最基础的语法讲起。\n第二行", "正文原样保留，包括换行");

// 多个附件
r = splitAttachments(`附件：\n- /t/a-x.pdf  (x.pdf)\n- /t/b-y.docx  (y.docx)\n\n看看`);
assert.deepEqual(r.files.map((f) => f.name), ["x.pdf", "y.docx"]);
assert.equal(r.body, "看看");

// 只发了附件、没写字
r = splitAttachments(`附件：\n- /t/a-x.pdf  (x.pdf)`);
assert.equal(r.files.length, 1);
assert.equal(r.body, "");

// 名字里自带括号
r = splitAttachments(`附件：\n- /t/a-笔记__1_.pdf  (笔记 (1).pdf)\n\n好`);
assert.deepEqual(r.files, [{ path: "/t/a-笔记__1_.pdf", name: "笔记 (1).pdf" }]);

// 没有附件的普通消息：原样
r = splitAttachments("附件在哪？我没看到");
assert.deepEqual(r.files, []);
assert.equal(r.body, "附件在哪？我没看到");

// 用户自己打了「附件：」开头但不是那个格式：原样，不吞内容
const typed = "附件：\n我等会儿再发";
r = splitAttachments(typed);
assert.deepEqual(r.files, []);
assert.equal(r.body, typed);

// 列表后面紧跟正文、没有空行：不是 Composer 写的形状，原样
const glued = `附件：\n- /t/a-x.pdf  (x.pdf)\n紧跟着`;
r = splitAttachments(glued);
assert.deepEqual(r.files, []);
assert.equal(r.body, glued);
