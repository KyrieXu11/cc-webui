import { useCallback, useEffect, useRef } from "react";

// 可拖拽的竖分隔条。照律枢那格的取值：min 280px，最多占 80%，默认 52%。
//
// ⚠️ 拖动时给 body 挂 `select-none` + `cursor-col-resize`：不挂的话鼠标一旦划出
// 分隔条，浏览器就开始选中两侧的正文，看着像卡住了。

interface Props {
  /** 右侧格宽度占容器的比例，0..1。 */
  ratio: number;
  onRatio: (r: number) => void;
  min?: number;
  maxRatio?: number;
}

export default function Splitter({
  ratio,
  onRatio,
  min = 280,
  maxRatio = 0.8,
}: Props) {
  const dragging = useRef(false);

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return;
      const total = window.innerWidth;
      // 鼠标右侧那段就是右格宽度。
      const width = Math.max(min, total - e.clientX);
      onRatio(Math.min(maxRatio, width / total));
    },
    [min, maxRatio, onRatio]
  );

  useEffect(() => {
    const stop = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("select-none", "cursor-col-resize");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      stop();
    };
  }, [onMove]);

  return (
    <div
      onMouseDown={(e) => {
        dragging.current = true;
        document.body.classList.add("select-none", "cursor-col-resize");
        e.preventDefault();
      }}
      title="拖动调整宽度"
      className="shrink-0 w-[3px] cursor-col-resize bg-line hover:bg-blue/60 active:bg-blue transition-colors"
      style={{ marginLeft: -1, marginRight: -1 }}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(ratio * 100)}
    />
  );
}
