import { useEffect, useState } from "react";

// 窄屏的判定点。Tailwind 的 `md` 是 768px，这里跟它保持一致，这样 JS 里的
// `narrow` 和样式里的 `max-md:` 永远说的是同一件事——两边各写一个数迟早会错位。
//
// 为什么需要 JS 而不是纯 CSS：抽屉是**有状态**的（开/关、点遮罩关掉、导航后
// 自动收起），而且窄屏下会话栏必须常驻在抽屉里、不受桌面那个 sidebarOpen 开关
// 影响。纯 `max-md:` 只能改样式，改不了这些。
export const NARROW_QUERY = "(max-width: 767px)";

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return narrow;
}
