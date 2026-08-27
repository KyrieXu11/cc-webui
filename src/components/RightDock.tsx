import { useEffect, useState } from "react";
import DockFileView from "./files/DockFileView";
import FileExplorer from "./FileExplorer";
import Splitter, { paneNarrow } from "./Splitter";
import { onDockOpen, type DockFile } from "../lib/dock-bridge";

// 右侧那一格：**左边项目树、右边预览/编辑**，中间一条可拖的线。
//
// ⚠️ **必须挂在 App 层，且只有一份，切视图/切会话都不卸载。** 律枢的注释写着为什么：
// 各处各渲染一份的话，切走就卸载，而卸载会销毁编辑器 iframe ——「累积三次再也
// 打不开」。所以这里的「收起」是 CSS 层面的 hidden，不卸载。
//
// ⚠️ **树和预览是并排，不是两个标签。**（2026-08-27 第三次调整。前两版：① 列表在左侧栏
// 而按钮在右上角；② 挪进这一格后做成「项目 / 本对话」两个都叫文件的标签。这一版是用户
// 原话：「应该做成点击项目文件名称之后，左边是项目树右边是预览，这样才方便」——树是导航，
// 点一个文件不该把导航换掉。所以树常驻左栏，打开的文档在右栏用标签叠。）
//
// ⚠️ **只有一个文件列表，就是项目树。** 取件台那条「按会话过滤」的列表已从 UI 撤掉
// （决策 4，见 docs/file-manager.md）。
//
// 文档标签是内存态，刷新即清（决策 15）：这一格的动作是「进去取件、改完出来」，
// 持久化会引入「标签指向的文件被 agent 删了/改名了」这类要维护的悬空状态。

// 宽档默认比例：装得下「树 + 编辑器」两栏，**同时给对话留出能用的宽度**。
// 0.62 试过，主栏在 1600px 窗口下只剩 292px（顶栏和输入框都开始互相叠），太狠。
// 窄档（只有树）不写在这儿——直接用 paneNarrow，和左侧栏同一组数，「两边一样宽」不会漂。
const DOCK_WIDE_RATIO = 0.5;

interface Props {
  /** 面板是否展开（顶栏那颗按钮）。收起时**不卸载**，只是 hidden。 */
  open: boolean;
  onClose: () => void;
  /** 有文件被要求打开时：面板可能是收起的，得让 App 把它展开。 */
  onRequestOpen: () => void;
  narrow: boolean;
  /** 服务端是否配了 ONLYOFFICE（/api/meta 的 features.office）。 */
  officeEnabled?: boolean;
  /** 当前项目 cwd；空串表示没进项目（此时不拉目录树）。 */
  cwd: string;
  /** 当前会话 id —— 只用于删除留痕。 */
  sessionId: string | null;
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
  onInsertFile,
  onPreviewFile,
}: Props) {
  const [docs, setDocs] = useState<DockFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // 「重新打开」用的令牌：按路径记一个计数，变化即让那份 DockFileView 重建。
  const [reloadTokens, setReloadTokens] = useState<Record<string, number>>({});

  useEffect(
    () =>
      onDockOpen((f) => {
        setDocs((cur) =>
          cur.some((t) => t.path === f.path) ? cur : [...cur, f]
        );
        setActive(f.path);
        onRequestOpen();
      }),
    [onRequestOpen]
  );

  const closeDoc = (path: string) => {
    setDocs((cur) => {
      const next = cur.filter((t) => t.path !== path);
      setActive((a) =>
        a !== path ? a : (next[next.length - 1]?.path ?? null)
      );
      return next;
    });
  };

  // 收起且没有打开过文档 → 真的不渲染。收起但有文档 → hidden（见顶部注释：
  // 卸载会销毁编辑器）。
  if (!open && docs.length === 0) return null;

  // **按内容分两档宽度，两档各记各的**（照律枢，它为此栽过一次）：只有树时窄，
  // 树+编辑器并排时宽。曾经的做法是一个「只放不收」的棘轮——打开过一次文档就把
  // 宽度记死，此后关掉所有文档、只剩一棵树也还占半屏（律枢真机反馈连说两次「太宽」）。
  // 不用在这里自己管：storageKey 一换，Splitter 的 effect 就去读那一档存的值。
  const hasDoc = docs.length > 0;

  return (
    <>
      {open && !narrow && (
        <Splitter
          cssVar="--dockw"
          edge="right"
          min={paneNarrow.min}
          maxRatio={0.85}
          storageKey={hasDoc ? "ccwebui.dock_w.wide" : "ccwebui.dock_w.narrow"}
          defaultRatio={hasDoc ? DOCK_WIDE_RATIO : paneNarrow.ratio}
          title="拖动调整右侧那格的宽度"
        />
      )}
      <div
        className={
          !open
            ? "hidden"
            : narrow
              ? "fixed inset-0 z-40 bg-canvas flex"
              : "dockcol border-l border-line bg-canvas"
        }
      >
        {/* ── 左栏：项目树（常驻导航，点文件不会把它换掉）───────────────── */}
        <div
          className={
            hasDoc
              ? "docktree shrink-0 min-w-0 border-r border-line"
              : "flex-1 min-w-0"
          }
        >
          {cwd ? (
            <FileExplorer
              embedded
              cwd={cwd}
              sessionId={sessionId}
              onInsertFile={onInsertFile}
              onPreviewFile={onPreviewFile}
              onClose={onClose}
            />
          ) : (
            <div className="p-4 text-[12px] text-subtle">还没有打开项目。</div>
          )}
        </div>

        {/* ⚠️ 内层这条线必须 originFrom="parent"：按窗口算会把左侧栏和主栏的宽度
            一起算进去，一拖就跳。 */}
        {hasDoc && !narrow && (
          <Splitter
            cssVar="--docktreew"
            edge="left"
            originFrom="parent"
            min={180}
            maxRatio={0.6}
            defaultRatio={0.34}
            defaultPx={240}
            storageKey="ccwebui.docktree_w"
            title="拖动调整目录树的宽度"
          />
        )}

        {/* ── 右栏：打开的文档（标签叠在上面）──────────────────────────── */}
        {hasDoc && (
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-stretch gap-0.5 px-2 pt-2 border-b border-line overflow-x-auto shrink-0">
              {docs.map((t) => (
                <div
                  key={t.path}
                  className={`flex items-center gap-1.5 pl-2.5 pr-1.5 h-7 rounded-t-md text-[12px] border-b-2 shrink-0 max-w-[200px] ${
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
                </div>
              ))}
            </div>

            {/* 藏 ≠ 卸载：每份文件的滚动位置、未保存的草稿、Office iframe 都靠这一点活着。 */}
            {docs.map((t) => (
              <div
                key={t.path}
                className={`flex-1 min-h-0 ${
                  active === t.path ? "" : "hidden"
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
        )}
      </div>
    </>
  );
}
