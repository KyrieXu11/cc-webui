import { useEffect, useMemo, useRef, useState } from "react";
import { getRecents, tildify, type RecentProject } from "../lib/fs";

interface Props {
  home: string;
  onSelect: (cwd: string) => void;
}

export default function HeaderSearch({ home, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [idx, setIdx] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    getRecents().then(setRecents).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter((r) => {
      const display = tildify(r.path, home).toLowerCase();
      return display.includes(q) || r.path.toLowerCase().includes(q);
    });
  }, [recents, query, home]);

  useEffect(() => setIdx(0), [query, open]);

  const pick = (cwd: string) => {
    onSelect(cwd);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[idx]) {
      e.preventDefault();
      pick(filtered[idx].path);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-[420px]">
      <div className="relative">
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
        >
          <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M9 9L12 12"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="搜索打开过的项目"
          className="w-full h-8 pl-8 pr-3 rounded-md bg-surface border border-line text-[12.5px] text-fg placeholder:text-subtle focus:outline-none focus:border-fg/25 transition-colors"
        />
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1.5 bg-surface border border-line-strong rounded-lg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.5)] overflow-hidden z-50">
          <div className="px-3 py-1.5 text-[10.5px] font-mono text-subtle uppercase tracking-[0.08em] border-b border-line">
            最近打开 · {filtered.length} 项
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-[12.5px] text-subtle">
                {recents.length === 0 ? "还没有打开过项目" : "无匹配"}
              </div>
            ) : (
              filtered.map((r, i) => (
                <button
                  key={r.path}
                  onClick={() => pick(r.path)}
                  onMouseEnter={() => setIdx(i)}
                  className={`w-full text-left px-3 py-1.5 font-mono text-[12.5px] truncate transition-colors ${
                    i === idx
                      ? "bg-blue/[0.15] text-fg"
                      : "text-muted hover:text-fg"
                  }`}
                  title={r.path}
                >
                  <Highlighted text={tildify(r.path, home)} query={query} />
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <span>{text}</span>;
  const pos = text.toLowerCase().indexOf(q);
  if (pos < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, pos)}
      <span className="text-fg font-medium bg-blue/20 rounded-sm px-[1px]">
        {text.slice(pos, pos + query.length)}
      </span>
      {text.slice(pos + query.length)}
    </span>
  );
}
