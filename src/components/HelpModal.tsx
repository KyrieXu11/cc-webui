import { useEffect } from "react";

interface Props {
  onClose: () => void;
}

const SHORTCUTS: Array<[string, string]> = [
  ["↵", "发送消息"],
  ["⇧↵", "换行"],
  ["Ctrl+O", "展开 / 收起所有 tool_call + thinking"],
  ["/", "调出斜杠命令 / skill 菜单"],
  ["↑ ↓ ↵", "在搜索 / 菜单 / 对话框中导航"],
  ["Esc", "关闭弹窗 / 菜单 / 预览浮窗"],
  ["Backspace（@path 末尾）", "整段删除引用"],
];

const FILE_TREE: Array<[string, string]> = [
  ["单击文件", "把 @相对路径 插入到对话框"],
  ["Ctrl / ⌘ + 单击", "打开文件预览浮窗"],
  ["浮窗标题栏拖拽", "移动预览浮窗"],
  ["浮窗右下角拖拽", "调整预览浮窗大小"],
  ["浮窗 @ 插入按钮", "把当前预览文件插入对话框"],
];

const LOCAL_COMMANDS: Array<[string, string]> = [
  ["/skills", "打开 skill 选择器，点击后插入 /<skill>"],
  ["/help", "打开这个帮助窗"],
  ["/clear", "开启新会话（保留当前项目）"],
  ["/exit", "关闭项目，返回主页"],
];

export default function HelpModal({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] bg-surface border border-line-strong rounded-xl overflow-hidden shadow-[0_28px_80px_-20px_rgba(0,0,0,0.85)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="text-fg text-[15px] font-semibold tracking-tight">
            快捷键 & 命令
          </h3>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-subtle hover:text-fg p-1 rounded"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M3 3L11 11M11 3L3 11"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-5 max-h-[60vh] overflow-y-auto">
          <section>
            <h4 className="text-[11px] font-mono text-subtle uppercase tracking-[0.08em] mb-2">
              键盘快捷键
            </h4>
            <dl className="text-[13px]">
              {SHORTCUTS.map(([key, desc]) => (
                <div
                  key={key}
                  className="flex items-baseline gap-4 py-1.5 border-b border-line last:border-b-0"
                >
                  <dt className="font-mono text-[12px] text-fg w-[180px] shrink-0">
                    {key}
                  </dt>
                  <dd className="text-muted">{desc}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h4 className="text-[11px] font-mono text-subtle uppercase tracking-[0.08em] mb-2">
              文件树 & 预览
            </h4>
            <dl className="text-[13px]">
              {FILE_TREE.map(([key, desc]) => (
                <div
                  key={key}
                  className="flex items-baseline gap-4 py-1.5 border-b border-line last:border-b-0"
                >
                  <dt className="font-mono text-[12px] text-fg w-[180px] shrink-0">
                    {key}
                  </dt>
                  <dd className="text-muted">{desc}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h4 className="text-[11px] font-mono text-subtle uppercase tracking-[0.08em] mb-2">
              本地命令（cc-webui）
            </h4>
            <dl className="text-[13px]">
              {LOCAL_COMMANDS.map(([cmd, desc]) => (
                <div
                  key={cmd}
                  className="flex items-baseline gap-4 py-1.5 border-b border-line last:border-b-0"
                >
                  <dt className="font-mono text-[12px] text-fg w-[180px] shrink-0">
                    {cmd}
                  </dt>
                  <dd className="text-muted">{desc}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[12px] text-subtle mt-3 leading-relaxed">
              输入 <span className="font-mono">/</span> 可看到所有可用命令,
              其中 SDK 提供的命令会被原样发给 claude-agent-sdk;
              以上本地命令由 cc-webui 拦截执行。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
