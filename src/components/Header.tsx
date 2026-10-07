import { useEffect, useRef, useState } from "react";
import { tildify } from "../lib/fs";
import HeaderSearch from "./HeaderSearch";
import ShareSessionDialog from "./ShareSessionDialog";
import { useAuth } from "../AuthGate";
import type { SessionSummary } from "../lib/sessions";
import { providerLabel, type AgentProvider } from "../lib/settings";

interface Props {
  /**
   * 右端留出 52px。**右上角那颗「文件面板」开关是绝对定位在窗口右上角的**（照律枢
   * 的 `.docktoggle`，位置不动、图标不变），面板收起时主栏顶到窗口右沿 ⇒ 不留位就
   * 会盖住「新对话」。面板展开时那颗按钮浮在右侧格上面，主栏不需要让位。
   */
  reserveRight?: boolean;
  // 窄屏专用：打开左抽屉（rail + 会话栏）。桌面那两根是常驻列，不需要。
  onOpenNav?: () => void;
  sessionId?: string | null;
  projectPath: string;
  home: string;
  provider: AgentProvider;
  onHome?: () => void;
  onNewChat?: () => void;
  onPickProject?: (cwd: string) => void;
  onPickSession?: (s: SessionSummary) => void;
  /** 共享名单或归属变了 —— 调用方据此刷新会话列表（转交出去后那一行会消失）。 */
  onSharesChanged?: () => void;
}

const PROVIDER_ACCENT: Record<AgentProvider, string> = {
  claude: "var(--color-provider-claude)",
  codex: "var(--color-provider-codex)",
};

export default function Header({
  onOpenNav,
  sessionId,
  projectPath,
  home,
  provider,
  onHome,
  onNewChat,
  onPickProject,
  onPickSession,
  onSharesChanged,
  reserveRight,
}: Props) {
  const accent = PROVIDER_ACCENT[provider];
  const { isAdmin } = useAuth();
  const [shareOpen, setShareOpen] = useState(false);

  // 搜索框：**地方不够就整块不渲染**，不靠 CSS 压缩。
  // 它的 `pl-8 pr-3` + 边框本身就是 46px，`width:0` / `min-w-0` 都压不下去（padding
  // 是 border-box 的下限），于是会溢出那个已经缩到 0 宽的 flex 容器，画在右边
  // 「via Claude」徽标上面 —— 右侧格拖宽时必现（实测 search 985→1031，chip 1001→1093）。
  // 量的是容器（`flex-1 min-w-0`，宽度＝剩余空间，与是否渲染子元素无关），所以不会自激。
  const searchBox = useRef<HTMLDivElement>(null);
  const [searchRoom, setSearchRoom] = useState(true);
  useEffect(() => {
    const el = searchBox.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) =>
      setSearchRoom(e.contentRect.width >= 170)
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 右侧那格能拖到很宽，主栏因此可以只剩两三百像素。右边那组是 shrink-0（徽标和
  // 按钮压扁了没法看），所以**地方不够时让它们整块消失，而不是互相叠**——叠起来的
  // 样子是「W▓b.Co▓Claude」（真机截图），看着像坏了。
  const bar = useRef<HTMLElement>(null);
  const [tight, setTight] = useState(false);
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setTight(e.contentRect.width < 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header
      ref={bar}
      className={`flex items-center gap-4 max-md:gap-2 h-14 pl-5 max-md:pl-1 shrink-0 ${
        reserveRight ? "pr-[52px]" : "pr-5 max-md:pr-2"
      }`}
    >
      {onOpenNav && (
        <button
          aria-label="打开侧栏"
          onClick={onOpenNav}
          className="md:hidden w-11 h-11 shrink-0 flex items-center justify-center text-muted"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {/* ⚠️ **不能 shrink-0**：cwd 是一长串绝对路径，不让它收缩的话整条顶栏会被顶得
          比主栏还宽，直接画到右侧那格上面（真机表现：搜索框浮在「本对话」标签上、
          「新对话」按钮整个不见了）。`min-w-0` 是为了让下面那行 truncate 真的生效。 */}
      <div className="flex items-center gap-2 min-w-0 max-md:flex-1">
        <button
          onClick={onHome}
          title="回到主页"
          className="flex items-center gap-2 shrink-0 whitespace-nowrap rounded px-1 py-0.5 hover:bg-fg/5 transition-colors"
        >
          <div className="w-2 h-2 rounded-full bg-blue pulse-dot" aria-hidden />
          <span className="font-semibold tracking-tight text-fg text-[15px] ml-0.5 max-md:hidden">
            Web Code
          </span>
        </button>
        <span className="text-subtle max-md:hidden">·</span>
        {/* ⚠️ **cwd 要有宽度上限。** 只有 truncate 的话它要等到被挤才收缩，宽屏上一条
            长绝对路径能独占一千像素，把中间的搜索框整个推到右边去（2500px 实测中心
            偏离顶栏中线 386px）。截断后完整路径在 title 里，鼠标一停就能看。 */}
        <span
          title={projectPath}
          className="font-mono text-[12px] text-subtle px-1.5 truncate max-w-[320px] max-md:px-0 max-md:max-w-none"
        >
          {tildify(projectPath, home) || projectPath}
        </span>
        {sessionId && !tight && (
          <>
            <span className="text-subtle max-md:hidden">·</span>
            <span
              className={`font-mono text-[11px] text-subtle px-1.5 shrink-0 ${
                tight ? "hidden" : "max-md:hidden"
              }`}
            >
              {sessionId.slice(0, 8)}
            </span>
          </>
        )}
      </div>
      {/* ⚠️ 不能用 flex-1：那是 basis:0、只吃「剩余」空间，而左边那串 cwd 绝对路径
          通常把整行吃光 —— 右侧格一开，搜索框就整块消失。basis:420 且可收缩：它先
          要到 420，逼着左边那组按 truncate 让位，两边都还在。
          ⚠️ **`mx-auto` 是这条顶栏唯一的「撑开」机制。** 三组都不 grow，所以宽屏上
          它们会全挤在左边、右侧留一大片空（2500px 的屏上「新对话」落在 x≈900，而
          右上角那颗面板开关孤零零在 2400 —— 真机反馈「顶部这个布局明显不合理」）。
          flex 的 auto margin **只吸收正的剩余空间**、空间为负时按 0 算，所以它把浪费
          的那片空白平分到搜索框两侧，而空间一紧就自动退场，退化路径一行没变。
          ⚠️ **不要改成「左右两条 `flex-1` 的等宽轨」去追求精确居中。** 试过：宽屏确实
          正中（2500px 下偏差 16px），但代价是优先级反转 —— 空间不够时缺口只能由搜索框
          或左边那组吞，实测 820px 下「新对话」跑到 x=824（顶栏只到 820）、直接压在右上角
          那颗面板开关上。现在这版偏差约 (左组宽 − 右组宽)/2 ≈ 150px，2184px 的顶栏上
          约 7%，看着就是居中；换来的是「品牌 > 操作 > 搜索」这个正确的让位次序。 */}
      <div
        ref={searchBox}
        className="flex-[0_1_420px] mx-auto flex justify-center min-w-0 max-md:hidden"
      >
        {searchRoom && onPickProject && onPickSession && (
          <HeaderSearch
            home={home}
            onPickProject={onPickProject}
            onPickSession={onPickSession}
          />
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div
          title={`当前 Agent: ${providerLabel(provider)}`}
          className={`${
            tight ? "hidden" : "hidden md:inline-flex"
          } items-center gap-1.5 h-7 pl-1.5 pr-2.5 rounded-full border border-line-strong bg-canvas/60`}
        >
          <span
            aria-hidden
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: accent,
              outline: `3px solid color-mix(in srgb, ${accent} 12%, transparent)`,
              outlineOffset: 0,
            }}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">
            via
          </span>
          <span className="text-[11.5px] text-fg font-medium tracking-tight">
            {providerLabel(provider)}
          </span>
        </div>
        <span
          className={`${tight ? "hidden" : "hidden md:inline"} w-px h-5 bg-line`}
        />
        {/* ⚠️ 共享的**主入口**。侧边栏那一行 hover 出来的图标是次要入口 ——
            hover-only 在一个 260px 宽的栏里根本发现不了（实测：功能上线后
            第一个问题就是"我怎么才能共享对话呢"）。人正看着一条对话想把它
            共享出去，手会往顶栏找。
            **仅管理员**（决策 41）：这台机器上谁能看到什么由管理员决定，普通用户
            没有把自己的会话分给别人的动作。真正拦住的是服务端那三条 `auth: "admin"`。
            没有 sessionId 就不画：新对话还没有 id，没有东西可共享。 */}
        {sessionId && isAdmin && (
          <button
            aria-label="共享对话"
            title="共享给其他人 / 转交归属"
            onClick={() => setShareOpen(true)}
            className="h-8 px-3 rounded-md text-[12px] text-muted hover:text-fg hover:bg-fg/5 transition-colors flex items-center gap-1.5"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <circle cx="5.2" cy="4.6" r="2.1" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M1.6 11.4c0-1.9 1.6-3.2 3.6-3.2s3.6 1.3 3.6 3.2"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <path
                d="M9.8 3.1a2.1 2.1 0 0 1 0 4M10.4 8.4c1.4.35 2.2 1.4 2.2 3"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            <span className={tight ? "hidden" : undefined}>共享</span>
          </button>
        )}
        <button
          aria-label="新对话"
          onClick={onNewChat}
          className="h-8 px-3 rounded-md text-[12px] text-muted hover:text-fg hover:bg-fg/5 transition-colors flex items-center gap-1.5"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 2V12M2 7H12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span className={tight ? "hidden" : undefined}>新对话</span>
        </button>
      </div>

      {shareOpen && sessionId && isAdmin && (
        <ShareSessionDialog
          sessionId={sessionId}
          provider={provider}
          onClose={() => setShareOpen(false)}
          onChanged={() => onSharesChanged?.()}
        />
      )}
    </header>
  );
}
