import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  skills: string[];
  onPick: (skill: string) => void;
  onClose: () => void;
}

export default function SkillsPicker({ skills, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => s.toLowerCase().includes(q));
  }, [skills, query]);

  useEffect(() => setIdx(0), [query]);

  useEffect(() => {
    const el = listRef.current;
    const item = el?.children[idx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[idx]) {
      e.preventDefault();
      onPick(filtered[idx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[14vh] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] bg-surface border border-line-strong rounded-xl overflow-hidden shadow-[0_28px_80px_-20px_rgba(0,0,0,0.85)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="text-fg text-[15px] font-semibold tracking-tight">
            选择 skill
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
        <div className="p-3 border-b border-line">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 skill"
            className="w-full h-9 px-3 rounded-md bg-canvas border border-line-strong text-[13px] text-fg placeholder:text-subtle focus:outline-none focus:border-blue/60"
          />
        </div>
        <div className="px-3 pt-2 pb-1 text-[10.5px] font-mono text-subtle uppercase tracking-[0.08em]">
          {filtered.length} 个 · ↑↓ 选择 · ↵ 插入
        </div>
        <div ref={listRef} className="max-h-[360px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-[12.5px] text-subtle text-center">
              无匹配
            </div>
          ) : (
            filtered.map((s, i) => (
              <button
                key={s}
                onClick={() => onPick(s)}
                onMouseEnter={() => setIdx(i)}
                className={`w-full flex items-center px-4 py-2 text-left font-mono text-[12.5px] transition-colors ${
                  i === idx
                    ? "bg-blue/[0.15] text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                <span className="text-subtle mr-2">/</span>
                {s}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
