import type { Theme } from "../lib/settings";

interface Props {
  onToggleSidebar?: () => void;
  onOpenProject?: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export default function Sidebar({
  onToggleSidebar,
  onOpenProject,
  theme,
  onToggleTheme,
}: Props) {
  return (
    <aside className="flex flex-col items-center justify-between w-14 border-r border-line py-3 shrink-0">
      <div className="flex flex-col items-center gap-1">
        <button
          onClick={onToggleSidebar}
          aria-label="切换侧栏"
          title="切换侧栏"
          className="p-2 rounded-md text-muted hover:text-fg hover:bg-fg/5 transition-colors"
        >
          <SidebarIcon />
        </button>
        <button
          onClick={onOpenProject}
          aria-label="打开项目"
          title="打开项目"
          className="p-2 rounded-md text-muted hover:text-fg hover:bg-fg/5 transition-colors"
        >
          <PlusIcon />
        </button>
      </div>
      <button
        onClick={onToggleTheme}
        aria-label={theme === "dark" ? "切换到日间" : "切换到夜间"}
        title={theme === "dark" ? "切换到日间" : "切换到夜间"}
        className="p-2 rounded-md text-muted hover:text-fg hover:bg-fg/5 transition-colors"
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    </aside>
  );
}

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
