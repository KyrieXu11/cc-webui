interface Props {
  onOpenProject: () => void;
}

export default function EmptyProjectSidebar({ onOpenProject }: Props) {
  return (
    <aside className="w-[260px] shrink-0 border-r border-line flex flex-col bg-canvas">
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <div className="w-10 h-10 rounded-xl bg-surface border border-line flex items-center justify-center mb-4">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M2 5V13C2 13.55 2.45 14 3 14H15C15.55 14 16 13.55 16 13V6.5C16 5.95 15.55 5.5 15 5.5H9L7 4H3C2.45 4 2 4.45 2 5Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted"
            />
          </svg>
        </div>
        <h3 className="text-fg text-[14px] font-semibold mb-1.5">
          未打开项目
        </h3>
        <p className="text-muted text-[12px] leading-relaxed mb-5">
          选一个文件夹开始一段新对话
        </p>
        <button
          onClick={onOpenProject}
          className="h-8 px-3.5 rounded-md bg-surface border border-line-strong text-[12.5px] text-fg hover:bg-raised hover:border-fg/25 transition-colors flex items-center gap-2"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path
              d="M1.5 4V11C1.5 11.55 1.95 12 2.5 12H11.5C12.05 12 12.5 11.55 12.5 11V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 3H2.5C1.95 3 1.5 3.45 1.5 4Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          打开项目
        </button>
      </div>
    </aside>
  );
}
