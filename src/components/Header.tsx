import { useEffect, useRef, useState } from "react";
import { tildify } from "../lib/fs";
import HeaderSearch from "./HeaderSearch";
import type { SessionSummary } from "../lib/sessions";
import { providerLabel, type AgentProvider } from "../lib/settings";

interface Props {
  // 窄屏专用：打开左抽屉（rail + 会话栏）。桌面那两根是常驻列，不需要。
  onOpenNav?: () => void;
  sessionId?: string | null;
  projectPath: string;
  home: string;
  provider: AgentProvider;
  onHome?: () => void;
  onNewChat?: () => void;
  onToggleFiles?: () => void;
  filesOpen?: boolean;
  onPickProject?: (cwd: string) => void;
  onPickSession?: (s: SessionSummary) => void;
}

const PROVIDER_ACCENT: Record<AgentProvider, string> = {
  claude: "#ef9d5a",
  codex: "#3ecf8e",
};

export default function Header({
  onOpenNav,
  sessionId,
  projectPath,
  home,
  provider,
  onHome,
  onNewChat,
  onToggleFiles,
  filesOpen,
  onPickProject,
  onPickSession,
}: Props) {
  const accent = PROVIDER_ACCENT[provider];

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

  return (
    <header className="flex items-center gap-4 max-md:gap-2 h-14 px-5 max-md:pl-1 max-md:pr-2 border-b border-line shrink-0">
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
        <span className="font-mono text-[12px] text-subtle px-1.5 truncate max-md:px-0">
          {tildify(projectPath, home) || projectPath}
        </span>
        {sessionId && (
          <>
            <span className="text-subtle max-md:hidden">·</span>
            <span className="font-mono text-[11px] text-subtle px-1.5 shrink-0 max-md:hidden">
              {sessionId.slice(0, 8)}
            </span>
          </>
        )}
      </div>
      {/* ⚠️ 不能用 flex-1：那是 basis:0、只吃「剩余」空间，而左边那串 cwd 绝对路径
          通常把整行吃光 —— 右侧格一开，搜索框就整块消失。basis:420 且可收缩：它先
          要到 420，逼着左边那组按 truncate 让位，两边都还在。 */}
      <div
        ref={searchBox}
        className="flex-[0_1_420px] flex justify-center min-w-0 max-md:hidden"
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
          className="hidden md:inline-flex items-center gap-1.5 h-7 pl-1.5 pr-2.5 rounded-full border border-line-strong bg-canvas/60"
        >
          <span
            aria-hidden
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: accent,
              outline: `3px solid ${accent}22`,
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
        <span className="hidden md:inline w-px h-5 bg-line" />
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
          <span>新对话</span>
        </button>
        <button
          aria-label="切换文件面板"
          title="文件面板（项目 / 本对话文件）"
          onClick={onToggleFiles}
          className={`p-2 rounded-md hover:bg-fg/5 transition-colors ${
            filesOpen ? "text-fg bg-fg/[0.04]" : "text-muted hover:text-fg"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect
              x="2"
              y="3"
              width="12"
              height="10"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <line
              x1="10"
              y1="3"
              x2="10"
              y2="13"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
