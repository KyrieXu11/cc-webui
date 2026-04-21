import { useEffect, useMemo, useRef, useState } from "react";
import { scanProjects, tildify } from "../lib/fs";

interface Props {
  onClose: () => void;
  onOpen: (path: string) => void;
}

type Entry = { path: string; display: string };

export default function OpenProjectDialog({ onClose, onOpen }: Props) {
  const [all, setAll] = useState<Entry[]>([]);
  const [home, setHome] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    scanProjects()
      .then(({ dirs, home }) => {
        if (cancelled) return;
        setHome(home);
        setAll(dirs.map((p) => ({ path: p, display: tildify(p, home) })));
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 500);
    const scored: Array<Entry & { score: number }> = [];
    for (const e of all) {
      const s = e.display.toLowerCase();
      const pos = s.indexOf(q);
      let score = 0;
      if (pos >= 0) {
        score = 100 - Math.min(pos, 50);
        if (s.endsWith(q) || s.endsWith(q + "/")) score += 20;
      } else {
        let i = 0;
        let hit = true;
        for (const ch of q) {
          const f = s.indexOf(ch, i);
          if (f < 0) {
            hit = false;
            break;
          }
          i = f + 1;
        }
        if (hit) score = 10;
      }
      if (score > 0) scored.push({ ...e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.display.length - b.display.length);
    return scored.slice(0, 500);
  }, [all, query]);

  useEffect(() => setIdx(0), [query]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const item = el.children[idx] as HTMLElement | undefined;
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
      onOpen(filtered[idx].path);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const submitCustom = () => {
    const q = query.trim();
    if (!q) return;
    let p = q;
    if (p.startsWith("~")) p = home + p.slice(1);
    onOpen(p);
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[14vh] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[620px] bg-surface border border-line-strong rounded-xl overflow-hidden shadow-[0_28px_80px_-20px_rgba(0,0,0,0.85)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h3 className="text-fg text-[15px] font-semibold tracking-tight">
            打开项目
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
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle"
              width="14"
              height="14"
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
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文件夹，或粘贴绝对路径回车"
              className="w-full h-9 pl-9 pr-3 rounded-md bg-canvas border border-line-strong text-[13px] text-fg placeholder:text-subtle focus:outline-none focus:border-blue/60"
            />
          </div>
        </div>
        <div className="px-5 pt-2 pb-1 text-[10.5px] font-mono text-subtle uppercase tracking-[0.08em]">
          {loading
            ? "扫描中…"
            : filtered.length > 0
              ? `${filtered.length} 个结果 · ↑↓ 选择 · ↵ 打开`
              : "未找到匹配；按回车将把你输入的路径作为绝对路径打开"}
        </div>
        <div ref={listRef} className="max-h-[380px] overflow-y-auto py-1">
          {filtered.map((f, i) => (
            <button
              key={f.path}
              onClick={() => onOpen(f.path)}
              onMouseEnter={() => setIdx(i)}
              className={`w-full flex items-center px-5 py-1.5 text-left font-mono text-[12.5px] transition-colors ${
                i === idx
                  ? "bg-blue/[0.15] text-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              <Highlighted text={f.display} query={query} />
            </button>
          ))}
          {!loading && filtered.length === 0 && query.trim() && (
            <button
              onClick={submitCustom}
              className="w-full flex items-center px-5 py-2 text-left font-mono text-[12.5px] text-fg bg-blue/[0.15]"
            >
              打开 "{query}"
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <span>{text}</span>;
  const lower = text.toLowerCase();
  const pos = lower.indexOf(q);
  if (pos < 0) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, pos)}
      <span className="text-fg font-medium bg-blue/25 rounded-sm px-[1px]">
        {text.slice(pos, pos + query.length)}
      </span>
      {text.slice(pos + query.length)}
    </span>
  );
}
