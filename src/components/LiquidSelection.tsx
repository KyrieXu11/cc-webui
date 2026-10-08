import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

type Rect = { x: number; y: number; width: number; height: number };
type Box = { left: number; top: number; width: number; height: number };
export function liquidSelectionRect(host: Box, target: Box): Rect {
  return { x: target.left - host.left, y: target.top - host.top, width: target.width, height: target.height };
}
const useLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

// One moving glass sheet, not an animated background on every button. Measure
// inside a non-scrolling rail: outer scrolling moves host and target together.
// Only geometry changes trigger work; CSS handles the bounded spring/glint.
export default function LiquidSelection({ container, activeKey, axis = "vertical", layoutKey }: {
  container: RefObject<HTMLElement>;
  activeKey: string | null;
  axis?: "vertical" | "horizontal";
  layoutKey?: string;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayout(() => {
    const host = container.current;
    const target = host && Array.from(host.querySelectorAll<HTMLElement>("[data-liquid-key]"))
      .find(el => el.dataset.liquidKey === activeKey);
    if (!host || !target) { setRect(null); return; }
    const measure = () => {
      const next = liquidSelectionRect(host.getBoundingClientRect(), target.getBoundingClientRect());
      setRect(prev => prev && (Object.keys(next) as Array<keyof Rect>).every(k => Math.abs(prev[k] - next[k]) < .5) ? prev : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host); observer.observe(target);
    return () => observer.disconnect();
  }, [container, activeKey, layoutKey]);
  if (!rect || !activeKey) return null;
  return <span aria-hidden className="liquid-selection" data-axis={axis}
    style={{ width: rect.width, height: rect.height, transform: `translate3d(${rect.x}px, ${rect.y}px, 0)` }}>
    <span key={activeKey} className="liquid-selection-skin" />
  </span>;
}
