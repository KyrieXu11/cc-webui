// 项目记忆（只读）前端的纯逻辑：索引怎么读、列表怎么排、[[链接]] 怎么变可点。

import assert from "node:assert/strict";
import {
  linkifyMemoryRefs,
  orderMemories,
  parseMemoryIndex,
  type Memory,
} from "./memory.ts";

const mem = (file: string, name: string, description = ""): Memory => ({
  file,
  name,
  description,
  type: "",
  modified: "",
  body: "",
  truncated: false,
});

// ── 索引：CLI 写的那种行，外加它认不出的行 ─────────────────────────────────
const index = parseMemoryIndex(
  [
    "# 记忆索引",
    "- [高一英语教师，只教一个班](teacher-role-context.md) — 阮老师；教材、学情",
    "- [投屏 PPT 版式](ppt-lesson-deck-format.md) - 讲题固定三页",
    "随手写的一句说明",
    "- [没有说明的](bare.md)",
  ].join("\n"),
);
assert.deepEqual(index, [
  { title: "高一英语教师，只教一个班", file: "teacher-role-context.md", hook: "阮老师；教材、学情" },
  { title: "投屏 PPT 版式", file: "ppt-lesson-deck-format.md", hook: "讲题固定三页" },
  { title: "没有说明的", file: "bare.md", hook: "" },
]);

// ── 排序：索引顺序在前，不在索引里的补在后面（照样看得见） ─────────────────
const ordered = orderMemories(index, [
  mem("zzz-orphan.md", "zzz-orphan", "没进索引的"),
  mem("ppt-lesson-deck-format.md", "ppt-lesson-deck-format"),
  mem("teacher-role-context.md", "teacher-role-context"),
  mem("bare.md", "bare", "文件里的描述"),
]);
assert.deepEqual(
  ordered.map((o) => [o.memory.file, o.indexed]),
  [
    ["teacher-role-context.md", true],
    ["ppt-lesson-deck-format.md", true],
    ["bare.md", true],
    ["zzz-orphan.md", false],
  ],
);
assert.equal(ordered[2].hook, "文件里的描述", "索引里没写说明时用文件自己的 description");
assert.equal(
  orderMemories([{ title: "丢了", file: "gone.md", hook: "" }], []).length,
  0,
  "索引里指向不存在文件的行不出现",
);

// ── [[链接]] ──────────────────────────────────────────────────────────────
assert.equal(
  linkifyMemoryRefs("相关 [[teacher-role-context]]、[[writing-style-no-ai-tone]]。"),
  "相关 [teacher-role-context](#memory:teacher-role-context)、[writing-style-no-ai-tone](#memory:writing-style-no-ai-tone)。",
);
assert.equal(linkifyMemoryRefs("没有链接"), "没有链接");
