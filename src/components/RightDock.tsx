import { useEffect, useState } from "react";
import DockFileView from "./files/DockFileView";
import Splitter from "./Splitter";
import { onDockOpen, type DockFile } from "../lib/dock-bridge";

// 右侧那一格（照律枢的 RightDock）。
//
// ⚠️ **必须挂在 App 层，且只有一份，切视图/切会话都不卸载。** 律枢的注释写着为什么：
// 各处各渲染一份的话，切走就卸载，而卸载会销毁编辑器 iframe ——「累积三次再也
// 打不开」。所以这里的隐藏是 CSS 层面的（父级不渲染时才真的没有），标签之间的
// 切换也只是 hidden，不卸载。
//
// tab 是内存态，刷新即清（决策 15）：取件台的动作是「进去取件、改完出来」，
// 持久化会引入「tab 指向的文件被 agent 删了/改名了」这类要维护的悬空状态。

export default function RightDock({
  narrow,
  officeEnabled,
}: {
  narrow: boolean;
  officeEnabled?: boolean;
}) {
  const [tabs, setTabs] = useState<DockFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [ratio, setRatio] = useState(0.52);
  // 「重新打开」用的令牌：按路径记一个计数，变化即让那份 DockFileView 重建。
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({});

  useEffect(
    () =>
      onDockOpen((f) => {
        setTabs((cur) =>
          cur.some((t) => t.path === f.path) ? cur : [...cur, f]
        );
        setActive(f.path);
      }),
    []
  );

  const close = (path: string) => {
    setTabs((cur) => {
      const next = cur.filter((t) => t.path !== path);
      setActive((a) =>
        a !== path ? a : (next[next.length - 1]?.path ?? null)
      );
      return next;
    });
  };

  if (tabs.length === 0) return null;

  const width = narrow ? "100%" : `${Math.round(ratio * 100)}%`;

  return (
    <>
      {!narrow && <Splitter ratio={ratio} onRatio={setRatio} />}
      <div
        className={
          narrow
            ? "fixed inset-0 z-40 bg-canvas flex flex-col"
            : "shrink-0 border-l border-line bg-canvas flex flex-col min-w-0"
        }
        style={narrow ? undefined : { width }}
      >
        <div className="flex items-stretch gap-0.5 px-2 pt-2 border-b border-line overflow-x-auto shrink-0">
          {tabs.map((t) => (
            <div
              key={t.path}
              className={`flex items-center gap-1.5 pl-2.5 pr-1.5 h-7 rounded-t-md text-[12px] border-b-2 shrink-0 max-w-[180px] ${
                active === t.path
                  ? "text-fg border-fg/60 bg-fg/[0.03]"
                  : "text-subtle border-transparent hover:text-muted"
              }`}
            >
              <button
                onClick={() => setActive(t.path)}
                className="truncate"
                title={t.path}
              >
                {t.name}
              </button>
              <button
                onClick={() => close(t.path)}
                className="shrink-0 text-subtle hover:text-fg px-0.5"
                title="关闭"
                aria-label={`关闭 ${t.name}`}
              >
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                  <path
                    d="M1.5 1.5L7.5 7.5M7.5 1.5L1.5 7.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {/* 藏 ≠ 卸载：每份文件的滚动位置、未保存的草稿、以后的 Office iframe
            都靠这一点活着。 */}
        {tabs.map((t) => (
          <div
            key={t.path}
            className={`flex-1 min-h-0 ${active === t.path ? "" : "hidden"}`}
          >
            <DockFileView
              path={t.path}
              name={t.name}
              officeEnabled={officeEnabled}
              reloadToken={reloadTokens[t.path] ?? 0}
              onReload={() =>
                setReloadTokens((m) => ({
                  ...m,
                  [t.path]: (m[t.path] ?? 0) + 1,
                }))
              }
            />
          </div>
        ))}
      </div>
    </>
  );
}
