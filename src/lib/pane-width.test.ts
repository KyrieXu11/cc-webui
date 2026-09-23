// 右侧文件格拖到头时，**对话主栏不能被挤没**。
//
// 用户 2026-09-17 报的那张图：在 PPT 上进了一次全屏、退出来之后，左边的对话只剩一条
// 几十像素的竖条（输入框叠成一摞，只看得到「idle」）。根因不在全屏——全屏只是让人能
// 在更宽的窗口里把线拖得更开；根因是上限只按 `maxRatio × innerWidth` 算，而同一行里
// 还站着一根 `shrink-0` 的定宽侧栏，被挤掉的只能是 `flex-1` 的主栏。

import assert from "node:assert/strict";
import { clampPaneWidth, MIN_MAIN_WIDTH } from "./pane-width.ts";

// ── 不传 reserve 时就是老行为（内层那条树/预览的线仍然走这一支）────────────
assert.equal(clampPaneWidth(500, 260, 0.85, 1000), 500);
assert.equal(clampPaneWidth(900, 260, 0.85, 1000), 850, "maxRatio 仍然是上限");
assert.equal(clampPaneWidth(10, 260, 0.85, 1000), 260, "min 仍然是下限");

// ── 回归：拖到头也得给主栏留下 MIN_MAIN_WIDTH ──────────────────────────────
// 1512px 窗口 + 展开的会话列表（rail 56 + 列表 260 = 316）。
const win = 1512;
const rail = 316;
const reserve = rail + MIN_MAIN_WIDTH;

const dragged = clampPaneWidth(99_999, 260, 0.85, win, reserve);
assert.equal(dragged, win - reserve, "拖到头＝刚好顶到主栏的下限");
assert.equal(win - rail - dragged, MIN_MAIN_WIDTH, "主栏正好剩下限，不是 0");

// 老规则在这个组合下算出来的是 1285，主栏 1512−316−1285 = −98 ⇒ 归零。
assert.ok(
  clampPaneWidth(99_999, 260, 0.85, win) - dragged > 400,
  "这条断言存在的意义：老上限比新上限宽出一大截，正是被挤没的那一截"
);

// ── 收起会话列表（只剩 56px 的 rail）时该松就松 ────────────────────────────
assert.equal(
  clampPaneWidth(99_999, 260, 0.85, win, 56 + MIN_MAIN_WIDTH),
  win - 56 - MIN_MAIN_WIDTH
);

// ── 两条上限取小的那个。窗口够宽（> reserve/0.15 ≈ 4773）之后，回到 maxRatio 说了算
//    ——「给主栏留 400px」在 6000px 的屏上已经不是约束了，别让它反过来把面板放宽。
assert.equal(clampPaneWidth(99_999, 260, 0.85, 6000, reserve), 5100, "0.85×6000");

// ── 窗口小到两头都塞不下时，min 压过 max（原有语义，别改）──────────────────
assert.equal(clampPaneWidth(99_999, 260, 0.85, 700, reserve), 260);

console.log("pane-width.test.ts: all assertions passed");
