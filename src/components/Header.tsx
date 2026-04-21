import { tildify } from "../lib/fs";
import HeaderSearch from "./HeaderSearch";

interface Props {
  sessionId?: string | null;
  projectPath: string;
  home: string;
  onHome?: () => void;
  onNewChat?: () => void;
  onToggleFiles?: () => void;
  filesOpen?: boolean;
  onPickProject?: (cwd: string) => void;
}

export default function Header({
  sessionId,
  projectPath,
  home,
  onHome,
  onNewChat,
  onToggleFiles,
  filesOpen,
  onPickProject,
}: Props) {
  return (
    <header className="flex items-center gap-4 h-14 px-5 border-b border-line shrink-0">
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        <button
          onClick={onHome}
          title="回到主页"
          className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-fg/5 transition-colors"
        >
          <div className="w-2 h-2 rounded-full bg-blue pulse-dot" aria-hidden />
          <span className="font-semibold tracking-tight text-fg text-[15px] ml-0.5">
            Web Code
          </span>
        </button>
        <span className="text-subtle">·</span>
        <span className="font-mono text-[12px] text-subtle px-1.5">
          {tildify(projectPath, home) || projectPath}
        </span>
        {sessionId && (
          <>
            <span className="text-subtle">·</span>
            <span className="font-mono text-[11px] text-subtle px-1.5">
              {sessionId.slice(0, 8)}
            </span>
          </>
        )}
      </div>
      <div className="flex-1 flex justify-center min-w-0">
        {onPickProject && (
          <HeaderSearch home={home} onSelect={onPickProject} />
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
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
          aria-label="切换文件侧栏"
          title="切换文件侧栏"
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
