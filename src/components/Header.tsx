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
      <div className="flex items-center gap-2 shrink-0 min-w-0 max-md:flex-1">
        <button
          onClick={onHome}
          title="回到主页"
          className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-fg/5 transition-colors"
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
            <span className="font-mono text-[11px] text-subtle px-1.5 max-md:hidden">
              {sessionId.slice(0, 8)}
            </span>
          </>
        )}
      </div>
      <div className="flex-1 flex justify-center min-w-0 max-md:hidden">
        {onPickProject && onPickSession && (
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
