// 可拖拽面板的宽度夹取规则（纯函数；改 CSS 变量那一半在 components/Splitter.tsx）。
//
// ⚠️ **上限不能只写成「窗口的百分之几」。** 那一行里除了这条线管的面板，还立着一根
// 定宽的左侧栏（rail 56px，展开会话列表时 56+260=316px），它是 `shrink-0`；而主栏是
// `flex-1 min-w-0`，所以被挤掉的永远是主栏。原来的上限是 0.85×innerWidth，完全没算
// 侧栏那一截，于是把右侧格拖到头时主栏直接归零：1512px 窗口 + 展开的会话列表，
// 1512 − 316 − 0.85×1512 = −98 ⇒ 对话只剩一条几十像素的竖条（输入框叠成一摞）。
//
// 进出全屏最容易撞上这一条：全屏时窗口更宽，能拖得更开、存下一个更大的绝对像素值；
// 退出后按新窗口重夹，夹出来的**仍然是 85%**，照样把主栏挤没。

/** 主栏（顶栏 + 消息列表 + 输入框）低于这个宽度就没法用了。
 *  下界来自 RightDock 里那条实测注释：0.62 档下主栏只剩 292px，「顶栏和输入框开始
 *  互相叠」。所以取一个明确高于它的数，而不是再试一次。 */
export const MIN_MAIN_WIDTH = 400;
// Desktop left rail + gutters + quiet splitter. The stored variable controls
// only the conversation list, not this fixed chrome or the mobile drawer.
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_LEFT_OFFSET = 56 + 10;
export const SIDEBAR_FIXED_WIDTH = 56 + 22 + 1;

export function paneWidthAt(clientX: number, edge: "left" | "right", span: { left: number; width: number }, offset = 0): number {
  return (edge === "right" ? span.left + span.width - clientX : clientX - span.left) - offset;
}

/**
 * 把 px 夹进 [min, max]。max 同时受两条约束，取更小的那个：
 *   ① maxRatio × spanWidth —— 老规则，「别占太满」；
 *   ② spanWidth − reserve —— 新规则，「给同一行里的别人留够」。
 * ⚠️ `min` 仍然压过 max（窗口太小时宁可让面板超出比例，也不能小到没法用）——
 * 这是原来就有的语义，别顺手改掉。
 */
export function clampPaneWidth(
  px: number,
  min: number,
  maxRatio: number,
  spanWidth: number,
  /** 这条线**另一侧**必须留下的像素：定宽兄弟的宽度 + 主栏下限。 */
  reserve = 0
): number {
  const max = Math.max(min, Math.min(spanWidth * maxRatio, spanWidth - reserve));
  return Math.min(Math.max(px, min), max);
}
