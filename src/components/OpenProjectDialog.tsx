import { useEffect, useMemo, useRef, useState } from "react";
import { getHome, getRecents, scanProjects, tildify } from "../lib/fs";
import { useAuth } from "../AuthGate";

interface Props {
  onClose: () => void;
  onOpen: (path: string) => void;
}

type Entry = { path: string; display: string };

export default function OpenProjectDialog({ onClose, onOpen }: Props) {
  // An account with no folder whitelist can open nothing at all — the scan
  // would walk $HOME and come back empty, leaving "扫描中…" then "未找到匹配"
  // plus an Enter-to-open affordance that can only 403. Say the real reason
  // instead. Not role-based: an admin whose own list was emptied is in exactly
  // the same position (assertCanOpen has no admin bypass).
  const { allowedPaths } = useAuth();
  const noFolders = allowedPaths.length === 0;
  const [recents, setRecents] = useState<string[]>([]);
  const [dirs, setDirs] = useState<string[]>([]);
  const [home, setHome] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanFailed, setScanFailed] = useState(false);
  const [scanVersion, setScanVersion] = useState(0);
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (noFolders) {
      setRecents([]);
      setHome("");
      return;
    }
    let cancelled = false;
    // Neither recent projects nor hand-typed paths should wait for a walk of
    // the filesystem. Recents are account-scoped and freshly authorised.
    getRecents().then((items) => {
      if (!cancelled) setRecents(items.map((item) => item.path));
    }).catch(() => {});
    getHome().then((value) => {
      if (!cancelled) setHome(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [noFolders]);

  useEffect(() => {
    if (noFolders) {
      setDirs([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setScanFailed(false);
    scanProjects({ refresh: scanVersion > 0, signal: controller.signal })
      .then(({ dirs, home }) => {
        if (controller.signal.aborted) return;
        setHome(home);
        setDirs(dirs);
      })
      .catch(() => { if (!controller.signal.aborted) setScanFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [noFolders, scanVersion]);

  const all = useMemo<Entry[]>(() => [...new Set([...recents, ...dirs])]
    .map((p) => ({ path: p, display: tildify(p, home) })), [recents, dirs, home]);

  const customPath = useMemo(() => {
    const q = query.trim();
    if (q.startsWith("/")) return q;
    if (home && (q === "~" || q.startsWith("~/"))) return home + q.slice(1);
    return null;
  }, [query, home]);

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
  useEffect(() => setIdx((i) => Math.min(i, Math.max(0, filtered.length - 1))), [filtered.length]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const item = el.children[idx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    // Let buttons keep their native Enter activation (especially Close).
    if (noFolders || !(e.target instanceof HTMLInputElement)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && (customPath || filtered[idx])) {
      e.preventDefault();
      onOpen(customPath || filtered[idx].path);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[14vh] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[620px] soft-dialog overflow-hidden"
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
            className="text-subtle hover:text-fg w-11 h-11 flex items-center justify-center rounded"
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
        {noFolders ? (
          <div className="px-5 py-6">
            <p className="text-fg text-[13.5px] leading-relaxed">
              你的账号还没有被授权任何文件夹。
            </p>
            <p className="text-muted text-[12.5px] leading-relaxed mt-2">
              找管理员在「管理 → 用户」里给你加上可访问的目录，例如{" "}
              <code className="font-mono text-subtle">~/code/**</code>
              ，之后刷新页面即可打开项目。
            </p>
          </div>
        ) : (
        <>
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
              className="w-full h-9 pl-9 pr-3 soft-input text-[13px] placeholder:text-subtle"
            />
          </div>
        </div>
        <div className="px-5 pt-2 pb-1 flex items-center justify-between gap-3 text-[11px] text-subtle" aria-live="polite">
          <span>
            {customPath ? "↵ 直接打开输入的路径" : filtered.length > 0
              ? `${filtered.length} 个结果 · ↑↓ 选择 · ↵ 打开`
              : loading ? "正在查找文件夹；也可直接粘贴路径" : "未找到匹配；可粘贴绝对路径或 ~/ 路径"}
            {loading && filtered.length > 0 && " · 后台扫描中…"}
          </span>
          <button disabled={loading} onClick={() => setScanVersion((v) => v + 1)}
            className="shrink-0 text-muted hover:text-fg disabled:opacity-50">
            {loading ? "扫描中…" : scanFailed ? "重试扫描" : "刷新目录"}
          </button>
        </div>
        {scanFailed && <p role="status" className="px-5 py-1 text-[12px] text-muted">
          目录扫描失败；仍可打开最近项目或直接输入路径。
        </p>}
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
          {customPath && (
            <button
              onClick={() => onOpen(customPath)}
              className="w-full flex items-center px-5 py-2 text-left font-mono text-[12.5px] text-fg bg-blue/[0.15]"
            >
              打开 "{query}"
            </button>
          )}
        </div>
        </>
        )}
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
