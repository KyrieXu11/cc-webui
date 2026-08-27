import { useEffect, useRef } from "react";

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
  maxRatio: number,
  /** 上限按谁的宽度算。内层分隔条要传所在容器的宽度，不能用窗口宽度。 */
  spanWidth: number = window.innerWidth
): number {
  const max = Math.max(min, spanWidth * maxRatio);
  const w = Math.min(Math.max(px, min), max);
  document.documentElement.style.setProperty(cssVar, `${w}px`);
  return w;
}

interface Props {
  cssVar: string;
  storageKey: string;
  /** 面板贴哪一侧——决定宽度怎么从鼠标位置算。 */
  edge: "left" | "right";
  /**
   * 从哪儿起算。`window`＝面板贴着窗口边（右侧格、左侧栏）；`parent`＝面板只是某个
   * 容器里的一栏（右侧格**内部**的树/预览那条线）——那时必须按容器左沿算，按窗口算
   * 会把左侧栏和主栏的宽度也算进去，一拖就跳。
   */
  originFrom?: "window" | "parent";
  min: number;
  /** 宽度上限占窗口的比例，给另一侧留活路。 */
  maxRatio: number;
  defaultRatio: number;
  /**
   * 固定像素的默认宽度，给了就压过 defaultRatio。
   * ⚠️ **内层分隔条应该用这个**：`.dockcol` 的宽度有 140ms 过渡，内层 Splitter 挂载
   * 那一刻量到的父容器还是过渡前的窄档宽度 ⇒ 按比例算出来的值被 min 顶掉，表现是
   * 「树栏第一次打开总是最窄」（实测 0.34×352=120 → 夹到 min 180）。
   */
  defaultPx?: number;
  title?: string;
}

export default function Splitter({
  cssVar,
  storageKey,
  edge,
  originFrom = "window",
  min,
  maxRatio,
  defaultRatio,
  defaultPx,
  title = "拖动调整宽度",
}: Props) {
  const self = useRef<HTMLDivElement>(null);
  const span = () => {
    if (originFrom === "window") return { left: 0, width: window.innerWidth };
    const box = self.current?.parentElement?.getBoundingClientRect();
    return box
      ? { left: box.left, width: box.width }
      : { left: 0, width: window.innerWidth };
  };
  const widthAt = (clientX: number) => {
    const { left, width } = span();
    return edge === "right" ? left + width - clientX : clientX - left;
  };

  useEffect(() => {
    const saved = Number(localStorage.getItem(storageKey));
    const w =
      saved > 0 ? saved : (defaultPx ?? Math.round(span().width * defaultRatio));
    const reclamp = () =>
      applyPaneWidth(
        cssVar,
        Number(localStorage.getItem(storageKey)) || w,
        min,
        maxRatio,
        span().width
      );
    reclamp();

    window.addEventListener("resize", reclamp);
    // ⚠️ 内层分隔条还要跟着**父容器**的宽度重夹，不只是窗口。三个理由，都实测过：
    //   ① `.dockcol` 的宽度有 140ms 过渡，挂载那一刻量到的还是过渡前的窄档宽度 ⇒
    //      min / maxRatio 会按那个错的跨度去夹（实测树栏第一次打开总是 180→211px，
    //      改 defaultPx 也没用，因为夹的是 maxRatio×352）；
    //   ② 外层那条线一拖，内层的上限就变了；
    //   ③ 存的是绝对像素，父容器变窄后不重夹会把另一栏挤没。
    const parent = self.current?.parentElement;
    let ro: ResizeObserver | null = null;
    if (originFrom === "parent" && parent && typeof ResizeObserver !== "undefined") {
      // 不会自激：父容器是 `flex:none; width:var(--dockw)`，宽度不由子元素决定。
      ro = new ResizeObserver(reclamp);
      ro.observe(parent);
    }
    return () => {
      window.removeEventListener("resize", reclamp);
      ro?.disconnect();
    };
  }, [cssVar, storageKey, min, maxRatio, defaultRatio, defaultPx, originFrom]);

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const move = (ev: MouseEvent) =>
      applyPaneWidth(cssVar, widthAt(ev.clientX), min, maxRatio, span().width);
    const up = (ev: MouseEvent) => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      localStorage.setItem(
        storageKey,
        String(
          applyPaneWidth(cssVar, widthAt(ev.clientX), min, maxRatio, span().width)
        )
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
      defaultPx ?? Math.round(span().width * defaultRatio),
      min,
      maxRatio,
      span().width
    );
  };

  return (
    <div
      ref={self}
      className="dragbar"
      onMouseDown={onDown}
      onDoubleClick={onDoubleClick}
      title={`${title}（双击复位）`}
      role="separator"
      aria-orientation="vertical"
    />
  );
}
