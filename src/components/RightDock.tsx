import { useEffect, useRef, useState } from "react";
import DockFileView from "./files/DockFileView";
import FileExplorer from "./FileExplorer";
import Splitter, { paneNarrow } from "./Splitter";
import { MIN_MAIN_WIDTH } from "../lib/pane-width";
import { onDockOpen, type DockFile } from "../lib/dock-bridge";
import { usePaneMotion } from "../lib/usePaneMotion";

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

// 只有幻灯片才配有「放映」那颗按钮（docx / xlsx 没有放映这回事）。
// ⚠️ 这张表跟着 server/office.ts 的 DOC_TYPE 里 `slide` 那几项走。
const SLIDE_RE = /\.(pptx?|odp)$/i;

interface Props {
  /** 面板是否展开（顶栏那颗按钮）。收起时**不卸载**，只是 hidden。 */
  open: boolean;
  /** 有文件被要求打开时：面板可能是收起的，得让 App 把它展开。 */
  onRequestOpen: () => void;
  narrow: boolean;
  /** 服务端是否配了 ONLYOFFICE（/api/meta 的 features.office）。 */
  officeEnabled?: boolean;
  /** 当前项目 cwd；空串表示没进项目（此时不拉目录树）。 */
  cwd: string;
  /** 当前会话 id —— 只用于删除留痕。 */
  sessionId: string | null;
  onPreviewFile: (absPath: string, relPath: string) => void;
}

export default function RightDock({
  open,
  onRequestOpen,
  narrow,
  officeEnabled,
  cwd,
  sessionId,
  onPreviewFile,
}: Props) {
  const [docs, setDocs] = useState<DockFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // 「最大化」：文档栏临时占满整个**窗口**。它自己**刻意不碰 Fullscreen API**——那个
  // 的 Esc 会被浏览器吞掉，而 Esc 是 ONLYOFFICE 退出放映的唯一按键（见 server/app.ts
  // 里那条 Permissions-Policy）。这里只是 CSS 的 `fixed inset-0`，Esc 照常传进去。
  const [maxed, setMaxed] = useState(false);
  // 「放映」：最大化**再加一层真·全屏**（Fullscreen API 打在我们自己这个容器上，
  // 顺带把标签栏也收掉）。用户 2026-09-20 报的就是缺这一层：放映跑在右侧那一格里，
  // 幻灯片按那一格的宽度缩成一小块，上下两条大黑边（原话「放映没有全屏啊」）。
  //
  // ⚠️ **别把它和「最大化」合成一颗**，两档要分开：
  //   · 全屏是放映唯一想要的东西，而编辑 docx 时把地址栏/标签页一起吞掉只会碍事；
  //   · 全屏这一层有代价 —— Esc 要按两下（第一下被浏览器拿去退全屏，第二下才进得了
  //     ONLYOFFICE 的放映器）。只让放映付这个代价，最大化那一档仍然是一下。
  // ⚠️ 这里能全屏、而 ONLYOFFICE 那颗 ⛶ 依旧不出现，靠的是同一条策略的两面：
  //   `Permissions-Policy: fullscreen=(self)` 放行**本源文档自己的元素**、挡掉跨源
  //   iframe。所以别把它改成给 iframe 加 `allow="fullscreen"`——那等于把 server/app.ts
  //   里那条决策推翻，放映的 Esc 会退回到「两下而且第二下常常落空」。
  const [presenting, setPresenting] = useState(false);
  const motion = usePaneMotion(open, !maxed && !presenting);
  // 放映时那行提示只亮几秒。⚠️ 退出按钮**不能**做成「动一下鼠标才浮现」：指针一落到
  // ONLYOFFICE 的 iframe 上，父文档就再也收不到 mousemove（Splitter 为同一件事要盖
  // 一层全屏遮罩），控件会永远躲着不出来。所以它常驻，只是很淡。
  const [hint, setHint] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
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

  // 面板收起 / 最后一份文档关掉之后再留在最大化态，就是一整屏的空白。
  useEffect(() => {
    if (open && docs.length > 0) return;
    setMaxed(false);
    setPresenting(false);
    // 只摘我们自己那一层，别把别人的全屏一起退了。
    if (document.fullscreenElement === shell.current) {
      void document.exitFullscreen().catch(() => {});
    }
  }, [open, docs.length]);

  // 退出全屏（Esc / F11 / 我们那颗「退出放映」）＝放映这一档结束。
  // ⚠️ **只摘全屏，`maxed` 留着。** 这时 ONLYOFFICE 的放映器多半还开着（第二下 Esc
  // 才轮到它），把文档栏这就缩回右侧那一格，屏幕上立刻又是用户报的那张图。
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!presenting) return;
    setHint(true);
    const t = window.setTimeout(() => setHint(false), 6000);
    return () => window.clearTimeout(t);
  }, [presenting]);

  const startPresent = () => {
    setMaxed(true);
    setPresenting(true);
    // 全屏失败（iOS Safari 没有元素全屏、或者反代把 Permissions-Policy 洗掉了）不是
    // 故障：`fixed inset-0` 那一层还在，至少是满窗口，比原来的一小格强。
    const p = shell.current?.requestFullscreen?.();
    void p?.catch(() => {});
  };

  const stopPresent = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else setPresenting(false);
  };

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
  if (!motion.present && docs.length === 0) return null;

  // **按内容分两档宽度，两档各记各的**（照律枢，它为此栽过一次）：只有树时窄，
  // 树+编辑器并排时宽。曾经的做法是一个「只放不收」的棘轮——打开过一次文档就把
  // 宽度记死，此后关掉所有文档、只剩一棵树也还占半屏（律枢真机反馈连说两次「太宽」）。
  // 不用在这里自己管：storageKey 一换，Splitter 的 effect 就去读那一档存的值。
  const hasDoc = docs.length > 0;

  return (
    <>
      {open && !narrow && !maxed && (
        <Splitter
          quiet
          cssVar="--dockw"
          edge="right"
          min={paneNarrow.min}
          maxRatio={0.85}
          storageKey={hasDoc ? "ccwebui.dock_w.wide" : "ccwebui.dock_w.narrow"}
          defaultRatio={hasDoc ? DOCK_WIDE_RATIO : paneNarrow.ratio}
          // ⚠️ **maxRatio 一个人拦不住。** 这一行里还立着左侧栏（rail 56px，展开会话
          //    列表是 316px，`shrink-0`），0.85×innerWidth 把它整个漏算了 ⇒ 线拖到头
          //    时被挤没的是主栏（1512 窗口 + 展开侧栏：1512−316−1285 = −98）。
          //    用户 2026-09-17 那张图就是这个：对话只剩一条竖条，只看得到「idle」。
          reserveSelector="[data-railcol]"
          // Include the chat card's 12px trailing gutter and the splitter's
          // 1px net width, so the visible panel still has MIN_MAIN_WIDTH.
          reserveMin={MIN_MAIN_WIDTH + 13}
          title="拖动调整右侧那格的宽度"
        />
      )}
      <div
        ref={shell}
        data-dockcol={motion.present && !narrow && !maxed ? true : undefined}
        data-pane-expanded={motion.expanded}
        aria-hidden={!open ? true : undefined}
        {...(!open ? { inert: "" } : {})}
        style={{
          width: !narrow && !maxed && !motion.expanded ? 0 : undefined,
          paddingRight: !narrow && !maxed && !motion.expanded ? 0 : undefined,
          opacity: motion.expanded ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
        }}
        className={
          !motion.present
            ? "hidden"
            : narrow || maxed
              ? "fixed inset-0 z-40 bg-surface flex dock-overlay"
              : "dockcol dock-frame"
        }
      >
        {/* 留白属于外层量尺，圆角裁切只包内容；手机抽屉/最大化/放映仍然满屏。
            切换档位只换 class，不卸载里面的编辑器或 Office iframe。 */}
        <div className={`flex ${!narrow && !maxed ? "flex-none" : "flex-1"} min-w-0 min-h-0 ${!narrow && !maxed ? "dock-surface" : ""}`}>
        {/* ── 左栏：项目树（常驻导航，点文件不会把它换掉）───────────────── */}
        <div
          className={
            maxed
              ? "hidden"
              : hasDoc
                ? "docktree shrink-0 min-w-0 border-r border-line"
                : "flex-1 min-w-0"
          }
        >
          {cwd ? (
            <FileExplorer
              embedded
              cwd={cwd}
              sessionId={sessionId}
              onPreviewFile={onPreviewFile}
              reserveRight={!hasDoc}
            />
          ) : (
            <div className="p-4 text-[12px] text-subtle">还没有打开项目。</div>
          )}
        </div>

        {/* ⚠️ 内层这条线必须 originFrom="parent"：按窗口算会把左侧栏和主栏的宽度
            一起算进去，一拖就跳。 */}
        {hasDoc && !narrow && !maxed && (
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
          <div className="relative flex-1 min-w-0 flex flex-col">
            {/* ⚠️ h-14 和目录树工具栏同高；右端留白与文件开关内缩位置一致。
                标签底对齐，下划线正好落在这条下边框上。
                ⚠️ 横向滚动只包住标签那一条：把「最大化」也放进 overflow-x-auto 里的话，
                标签一多它就被滚走了。 */}
            <div
              className={`dock-document-toolbar flex items-center pr-[64px] max-md:pr-[68px] border-b border-line shrink-0 ${maxed && !narrow ? "h-[68px] pt-3" : "h-14"} ${
                presenting ? "hidden" : ""
              }`}
            >
            <div className="flex items-end gap-0.5 pb-0 pl-2 flex-1 min-w-0 h-full overflow-x-auto">
              {docs.map((t) => (
                <div
                  key={t.path}
                  data-active={active === t.path}
                  className={`dock-tab flex items-center gap-1.5 pl-2.5 pr-1.5 h-8 text-[12px] border-b-2 shrink-0 max-w-[200px] ${
                    active === t.path
                      ? ""
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
              {officeEnabled && active && SLIDE_RE.test(active) && (
                <button
                  onClick={startPresent}
                  className="shrink-0 ml-1 px-2 py-1 rounded-md text-[11.5px] text-subtle hover:text-fg hover:bg-fg/5 transition-colors"
                  // ⚠️ 「开始放映」那一下只能由用户点 ONLYOFFICE 自己的按钮：它的
                  //    api.js 公开方法表里没有任何启动放映的命令（showMessage /
                  //    grabFocus / serviceCommand … 全表都查过），跨源也没法替它按键。
                  //    我们能做的就是先把屏幕腾出来。
                  title="全屏放映：进去之后点工具栏的「开始幻灯片放映」。Esc 先退全屏，再按一次才退出放映（ONLYOFFICE 网页版就是两下）。"
                >
                  放映
                </button>
              )}
              <button
                onClick={() => setMaxed((v) => !v)}
                className="shrink-0 ml-1 p-1.5 rounded-md text-subtle hover:text-fg hover:bg-fg/5 transition-colors"
                title={maxed ? "还原" : "最大化（只铺满窗口，不进全屏）"}
                aria-label={maxed ? "还原文档栏" : "最大化文档栏"}
              >
                {maxed ? (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M10 6h4M10 6V2M6 10H2M6 10v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M10 2h4v4M6 14H2v-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M14 2l-5 5M2 14l5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>

            {presenting && (
              <div className="absolute top-2 right-[52px] z-50 flex items-center gap-2">
                {hint && (
                  <span className="rounded-md bg-canvas/85 px-2 py-1 text-[11.5px] text-muted">
                    点工具栏「开始幻灯片放映」· Esc 退全屏，再按一次退出放映
                  </span>
                )}
                <button
                  onClick={stopPresent}
                  className="rounded-md bg-canvas/85 px-2 py-1 text-[11.5px] text-subtle opacity-30 hover:opacity-100 hover:text-fg transition-opacity"
                  title="退出全屏（ONLYOFFICE 若还在放映，再按一次 Esc）"
                >
                  退出放映
                </button>
              </div>
            )}

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
      </div>
    </>
  );
}
