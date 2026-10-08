import { useEffect, useLayoutEffect, useState } from "react";

export const PANE_MOTION_MS = 280;
const useLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function paneMotionVisibility(open: boolean, mounted: boolean, entered: boolean, animate = true) {
  return { present: animate ? open || mounted : open, expanded: animate ? open && entered : open };
}

// Keep closing content only long enough to paint its exit; logical open still
// controls inert/pointer-events immediately. Two bounded frames establish the
// collapsed layout before entry. No transform/filter on pane hosts: fixed
// sharing/delete dialogs must remain viewport-scoped, and editors stay mounted.
export function usePaneMotion(open: boolean, animate = true) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(open);
  useLayout(() => {
    if (!animate) { setMounted(open); setEntered(open); return; }
    if (open) {
      setMounted(true);
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setEntered(true));
      });
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    }
    setEntered(false);
    if (!mounted) return;
    const timer = setTimeout(() => setMounted(false), PANE_MOTION_MS + 40);
    return () => clearTimeout(timer);
  }, [open, animate]);
  return paneMotionVisibility(open, mounted, entered, animate);
}
