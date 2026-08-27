import { useEffect, useState } from "react";
import DockFileView from "./files/DockFileView";
import FilesPanel from "./files/FilesPanel";
import FileExplorer from "./FileExplorer";
import Splitter from "./Splitter";
import { onDockOpen, type DockFile } from "../lib/dock-bridge";

// 右侧那一格（项目 / 文件 / 打开的文档），照律枢的 RightDock。
//
// ⚠️ **必须挂在 App 层，且只有一份，切视图/切会话都不卸载。** 律枢的注释写着为什么：
// 各处各渲染一份的话，切走就卸载，而卸载会销毁编辑器 iframe ——「累积三次再也
// 打不开」。所以这里的「关闭」是 CSS 层面的 hidden，不卸载。
//
// ⚠️ **文件相关的东西全在这一格里，不许再往左侧栏放第二份。**（2026-08-27 返工：
// 取件台列表原来做成了左侧栏的一个 tab，而项目文件树在右边——按钮在右上角、开出来的
// 东西在左边，两个文件面板抢一个位置。律枢是「一格多标签」，这里对齐。）
//
// 文档标签是内存态，刷新即清（决策 15）：取件台的动作是「进去取件、改完出来」，
// 持久化会引入「标签指向的文件被 agent 删了/改名了」这类要维护的悬空状态。

type Tab =
  | { kind: "tree" }
  | { kind: "files" }
  | { kind: "doc"; path: string; name: string };

const keyOf = (t: Tab) => (t.kind === "doc" ? `doc:${t.path}` : t.kind);

interface Props {
  /** 面板是否展开（右上角那颗按钮）。收起时**不卸载**，只是 hidden。 */
  open: boolean;
  onClose: () => void;
  /** 有文件被要求打开时：面板可能是收起的，得让 App 把它展开。 */
  onRequestOpen: () => void;
  narrow: boolean;
  /** 服务端是否配了 ONLYOFFICE（/api/meta 的 features.office）。 */
  officeEnabled?: boolean;
  /** 当前项目 cwd；空串表示没进项目（此时不拉目录树）。 */
  cwd: string;
  /** 当前会话 id —— 「文件」标签（取件台）按它取本对话文件。 */
  sessionId: string | null;
  /** 变化即让取件台重新拉取（turn 结束时前进）。 */
  refreshKey?: number;
  onInsertFile: (absPath: string, relPath: string) => void;
  onPreviewFile: (absPath: string, relPath: string) => void;
}

export default function RightDock({
  open,
  onClose,
  onRequestOpen,
  narrow,
  officeEnabled,
  cwd,
  sessionId,
  refreshKey,
  onInsertFile,
  onPreviewFile,
}: Props) {
  const [docs, setDocs] = useState<DockFile[]>([]);
  const [active, setActive] = useState<string>("files");
  const [ratio, setRatio] = useState(0.52);
  // 「重新打开」用的令牌：按路径记一个计数，变化即让那份 DockFileView 重建。
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({});

  useEffect(
    () =>
      onDockOpen((f) => {
        setDocs((cur) =>
          cur.some((t) => t.path === f.path) ? cur : [...cur, f]
        );
        setActive(`doc:${f.path}`);
        onRequestOpen();
      }),
    [onRequestOpen]
  );

  const closeDoc = (path: string) => {
    setDocs((cur) => {
      const next = cur.filter((t) => t.path !== path);
      setActive((a) =>
        a !== `doc:${path}`
          ? a
          : next.length
            ? `doc:${next[next.length - 1].path}`
            : "files"
      );
      return next;
    });
  };

  const tabs: Tab[] = [
    { kind: "tree" },
    { kind: "files" },
    ...docs.map((d) => ({ kind: "doc" as const, ...d })),
  ];

  // 收起且没有打开过文档 → 真的不渲染。收起但有文档 → hidden（见顶部注释：
  // 卸载会销毁编辑器）。
  if (!open && docs.length === 0) return null;

  const width = narrow ? "100%" : `${Math.round(ratio * 100)}%`;

  return (
    <>
      {open && !narrow && <Splitter ratio={ratio} onRatio={setRatio} />}
      <div
        className={
          !open
            ? "hidden"
            : narrow
              ? "fixed inset-0 z-40 bg-canvas flex flex-col"
              : "shrink-0 border-l border-line bg-canvas flex flex-col min-w-0"
        }
        style={narrow || !open ? undefined : { width }}
      >
        <div className="flex items-stretch gap-0.5 px-2 pt-2 border-b border-line overflow-x-auto shrink-0">
          {tabs.map((t) => {
            const k = keyOf(t);
            const label =
              t.kind === "tree" ? "项目" : t.kind === "files" ? "文件" : t.name;
            return (
              <div
                key={k}
                className={`flex items-center gap-1.5 pl-2.5 h-7 rounded-t-md text-[12px] border-b-2 shrink-0 max-w-[180px] ${
                  t.kind === "doc" ? "pr-1.5" : "pr-2.5"
                } ${
                  active === k
                    ? "text-fg border-fg/60 bg-fg/[0.03]"
                    : "text-subtle border-transparent hover:text-muted"
                }`}
              >
                <button
                  onClick={() => setActive(k)}
                  className="truncate"
                  title={t.kind === "doc" ? t.path : undefined}
                >
                  {label}
                </button>
                {t.kind === "doc" && (
                  <button
                    onClick={() => closeDoc(t.path)}
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
                )}
              </div>
            );
          })}
          <div className="flex-1 min-w-[8px]" />
          <button
            onClick={onClose}
            className="shrink-0 self-center text-subtle hover:text-fg px-1.5 py-1 rounded hover:bg-fg/5"
            title="收起面板"
            aria-label="收起面板"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path
                d="M2 2L9 9M9 2L2 9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* 藏 ≠ 卸载：每份文件的滚动位置、未保存的草稿、Office iframe 都靠这一点
            活着；目录树的展开状态同理。 */}
        <div
          className={`flex-1 min-h-0 ${active === "tree" ? "" : "hidden"}`}
        >
          {cwd ? (
            <FileExplorer
              embedded
              cwd={cwd}
              onInsertFile={onInsertFile}
              onPreviewFile={onPreviewFile}
            />
          ) : (
            <div className="p-4 text-[12px] text-subtle">还没有打开项目。</div>
          )}
        </div>

        <div
          className={`flex-1 min-h-0 ${active === "files" ? "" : "hidden"}`}
        >
          <FilesPanel
            sessionId={sessionId}
            cwd={cwd}
            refreshKey={refreshKey}
          />
        </div>

        {docs.map((t) => (
          <div
            key={t.path}
            className={`flex-1 min-h-0 ${
              active === `doc:${t.path}` ? "" : "hidden"
            }`}
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
