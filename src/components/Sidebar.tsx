import type { Theme } from "../lib/settings";
import { useAuth } from "../AuthGate";

interface Props {
  /** 窄屏＝关抽屉，桌面＝收起会话栏。文案/图标跟着变，见下面的注释。 */
  onToggleSidebar?: () => void;
  narrow?: boolean;
  expanded?: boolean;
  onOpenProject?: () => void;
  onOpenHelp?: () => void;
  onOpenAdmin?: () => void;
  /** 查看项目记忆（只读）。只在打开了项目时由 App 传进来；没传就不画这颗按钮。 */
  onOpenMemory?: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export default function Sidebar({
  onToggleSidebar,
  narrow = false,
  expanded = false,
  onOpenProject,
  onOpenHelp,
  onOpenAdmin,
  onOpenMemory,
  theme,
  onToggleTheme,
}: Props) {
  const { user, isAdmin, signOut } = useAuth();
  return (
    <aside className="workbench-rail flex flex-col items-center justify-between w-14 border-r border-line py-3 shrink-0">
      <div className="flex flex-col items-center gap-1">
        {/* 窄屏下这颗按钮做的是「关掉抽屉」，所以画成 ✕ 并改文案 —— 同一个图标同一个
            位置却做两件事，用户没法知道点下去会发生什么。 */}
        <button
          onClick={onToggleSidebar}
          aria-label={narrow ? "关闭侧栏" : "切换侧栏"}
          title={narrow ? "关闭侧栏" : "切换侧栏"}
          aria-expanded={narrow ? undefined : expanded}
          data-expanded={expanded}
          className="panel-toggle p-2"
        >
          {narrow ? <CloseIcon /> : <SidebarIcon />}
        </button>
        <button
          onClick={onOpenProject}
          aria-label="打开项目"
          title="打开项目"
          className="p-2 rounded-control text-muted hover:text-fg hover:bg-raised transition-colors"
        >
          <PlusIcon />
        </button>
        {onOpenMemory && (
          <button
            onClick={onOpenMemory}
            aria-label="项目记忆"
            title="项目记忆（只读）：Claude / Codex 共用"
            className="p-2 rounded-control text-muted hover:text-fg hover:bg-raised transition-colors"
          >
            <MemoryIcon />
          </button>
        )}
      </div>
      <div className="flex flex-col items-center gap-1">
        {/* Admin only — a plain user never sees this exists. */}
        {isAdmin && (
          <button
            onClick={onOpenAdmin}
            aria-label="管理"
            title="管理（用户 / 权限 / 飞书映射）"
            className="p-2 rounded-control text-muted hover:text-fg hover:bg-raised transition-colors"
          >
            <AdminIcon />
          </button>
        )}
        <button
          onClick={onOpenHelp}
          aria-label="操作手册"
          title="操作手册（快捷键说明）"
          className="p-2 rounded-control text-muted hover:text-fg hover:bg-raised transition-colors"
        >
          <HelpIcon />
        </button>
        <button
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "切换到日间" : "切换到夜间"}
          title={theme === "dark" ? "切换到日间" : "切换到夜间"}
          className="p-2 rounded-control text-muted hover:text-fg hover:bg-raised transition-colors"
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          onClick={signOut}
          aria-label="退出登录"
          title={`${user.username}${isAdmin ? "（管理员）" : ""} — 退出登录`}
          className="p-2 rounded-control text-muted hover:text-fg hover:bg-raised transition-colors"
        >
          <SignOutIcon />
        </button>
      </div>
    </aside>
  );
}

const AdminIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

const SignOutIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

const HelpIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M6 6.2C6 5 6.9 4.3 8 4.3C9.1 4.3 10 5 10 6.2C10 7 9.5 7.4 8.8 7.8C8.2 8.1 8 8.4 8 9"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <circle cx="8" cy="11.3" r="0.75" fill="currentColor" />
  </svg>
);

const SidebarIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect
      x="2"
      y="3"
      width="12"
      height="10"
      rx="1.5"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d="M7 2V12M2 7H12"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

const SunIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M8 2v1.6M8 12.4V14M14 8h-1.6M3.6 8H2M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <path
      d="M13.5 9.5C12.8 9.8 12 10 11 10C7.7 10 5 7.3 5 4C5 3 5.2 2.2 5.5 1.5C3.2 2.5 1.5 4.9 1.5 7.7C1.5 11.2 4.3 14 7.8 14C10.6 14 13 12.3 14 10C13.8 10 13.6 9.8 13.5 9.5Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

const CloseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path
      d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

// 一本打开的书：「记下来的东西」，和旁边几颗图标同一套线宽。
const MemoryIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M8 4.2C6.6 3.2 4.7 2.8 2.5 3v9.3c2.2-.2 4.1.2 5.5 1.2 1.4-1 3.3-1.4 5.5-1.2V3c-2.2-.2-4.1.2-5.5 1.2Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <path d="M8 4.2v9.3" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
