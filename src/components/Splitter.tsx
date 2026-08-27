import { useEffect } from "react";

// 可拖拽的竖分隔条。**照搬律枢 `app/src/components/Splitter.tsx` 的机制**（配色是我们
// 自己的）。四条都是它踩出来的，别按"看起来更简单"的写法改回去：
//
// ⚠️ ① **宽度写在 CSS 变量上，不走 React state。** 拖动时每帧 setState 会把整条对话
//    （消息列表 + 正在流式输出的时间线）连同两侧面板一起重渲染，拖起来发涩。改
//    style property 只触发一次样式重算。
// ⚠️ ② **拖动中盖一层全屏透明遮罩**（`body.resizing::after`）。ONLYOFFICE 是 iframe，
//    指针一进去事件就被它吞掉、拖动当场断连。
// ⚠️ ③ **拖动中必须关掉宽度过渡。** 每帧都在改变量，而 140ms 过渡会让面板慢一拍跟上
//    鼠标——手感就是「线不跟手」。`body.resizing` 正好是这段区间。
// ⚠️ ④ **存的是绝对像素，所以窗口变窄时要重新夹一次。** 不重夹会把另一侧挤没。
//
// storageKey 换一个值，effect 会重跑并读那一档存的宽度 —— 「按内容分档、各记各的」
// 就是靠这一点实现的，见 RightDock 的 wideMode。

/** 窄档：装列表用，和左侧栏同宽。 */
export const paneNarrow = { min: 260, ratio: 0.22 };

export function applyPaneWidth(
  cssVar: string,
  px: number,
  min: number,
  maxRatio: number
): number {
  const max = Math.max(min, window.innerWidth * maxRatio);
  const w = Math.min(Math.max(px, min), max);
  document.documentElement.style.setProperty(cssVar, `${w}px`);
  return w;
}

interface Props {
  cssVar: string;
  storageKey: string;
  /** 面板贴窗口哪一侧——决定宽度怎么从鼠标位置算。 */
  edge: "left" | "right";
  min: number;
  /** 宽度上限占窗口的比例，给另一侧留活路。 */
  maxRatio: number;
  defaultRatio: number;
  title?: string;
}

export default function Splitter({
  cssVar,
  storageKey,
  edge,
  min,
  maxRatio,
  defaultRatio,
  title = "拖动调整宽度",
}: Props) {
  const widthAt = (clientX: number) =>
    edge === "right" ? window.innerWidth - clientX : clientX;

  useEffect(() => {
    const saved = Number(localStorage.getItem(storageKey));
    const w = saved > 0 ? saved : Math.round(window.innerWidth * defaultRatio);
    applyPaneWidth(cssVar, w, min, maxRatio);
    const onResize = () =>
      applyPaneWidth(
        cssVar,
        Number(localStorage.getItem(storageKey)) || w,
        min,
        maxRatio
      );
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [cssVar, storageKey, min, maxRatio, defaultRatio]);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const move = (ev: MouseEvent) =>
      applyPaneWidth(cssVar, widthAt(ev.clientX), min, maxRatio);
    const up = (ev: MouseEvent) => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      localStorage.setItem(
        storageKey,
        String(applyPaneWidth(cssVar, widthAt(ev.clientX), min, maxRatio))
      );
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // 双击回默认宽度：拖到极窄之后靠拖回来很别扭。
  const onDoubleClick = () => {
    localStorage.removeItem(storageKey);
    applyPaneWidth(
      cssVar,
      Math.round(window.innerWidth * defaultRatio),
      min,
      maxRatio
    );
  };

  return (
    <div
      className="dragbar"
      onMouseDown={onDown}
      onDoubleClick={onDoubleClick}
      title={`${title}（双击复位）`}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
