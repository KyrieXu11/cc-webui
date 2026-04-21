import { useEffect, useMemo, useRef, useState } from "react";
import { getRecents, tildify, timeAgo, type RecentProject } from "../lib/fs";
import { listSessions, type SessionSummary } from "../lib/sessions";

interface Props {
  home: string;
  onPickProject: (cwd: string) => void;
  onPickSession: (s: SessionSummary) => void;
}

type ProjectHit = { kind: "project"; path: string; lastUsed: number };
type SessionHit = {
  kind: "session";
  session: SessionSummary;
  title: string;
};
type Hit = ProjectHit | SessionHit;

export default function HeaderSearch({
  home,
  onPickProject,
  onPickSession,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [idx, setIdx] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    getRecents().then(setRecents).catch(() => {});
    listSessions(100).then(setSessions).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const { projectHits, sessionHits } = useMemo(() => {
    const q = query.trim().toLowerCase();

    const pHits: ProjectHit[] = recents
      .filter((r) => {
        if (!q) return true;
        const disp = tildify(r.path, home).toLowerCase();
        return disp.includes(q) || r.path.toLowerCase().includes(q);
      })
      .slice(0, q ? 10 : 5)
      .map((r) => ({
        kind: "project",
        path: r.path,
        lastUsed: r.lastUsed,
      }));

    const sHits: SessionHit[] = sessions
      .filter((s) => {
        if (!s.cwd) return false;
        if (!q) return true;
        const title = (
          s.customTitle ||
          s.summary ||
          s.firstPrompt ||
          ""
        ).toLowerCase();
        return title.includes(q) || s.cwd.toLowerCase().includes(q);
      })
      .slice(0, q ? 20 : 6)
      .map((s) => ({
        kind: "session",
        session: s,
        title: s.customTitle || s.summary || s.firstPrompt || "（无摘要）",
      }));

    return { projectHits: pHits, sessionHits: sHits };
  }, [recents, sessions, query, home]);

  const flat: Hit[] = useMemo(
    () => [...projectHits, ...sessionHits],
    [projectHits, sessionHits]
  );

  useEffect(() => setIdx(0), [query, open]);

  const pick = (hit: Hit) => {
    if (hit.kind === "project") onPickProject(hit.path);
    else onPickSession(hit.session);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flat[idx]) {
      e.preventDefault();
      pick(flat[idx]);
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
          placeholder="搜索项目或对话"
          className="w-full h-8 pl-8 pr-3 rounded-md bg-surface border border-line text-[12.5px] text-fg placeholder:text-subtle focus:outline-none focus:border-fg/25 transition-colors"
        />
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1.5 bg-surface border border-line-strong rounded-lg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.5)] overflow-hidden z-50">
          <div className="max-h-[420px] overflow-y-auto py-1">
            {projectHits.length > 0 && (
              <div>
                <SectionHeader label="项目" count={projectHits.length} />
                {projectHits.map((h, i) => {
                  const absoluteIdx = i;
                  return (
                    <button
                      key={h.path}
                      onClick={() => pick(h)}
                      onMouseEnter={() => setIdx(absoluteIdx)}
                      className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-3 transition-colors ${
                        absoluteIdx === idx
                          ? "bg-blue/[0.15]"
                          : "hover:bg-fg/5"
                      }`}
                      title={h.path}
                    >
                      <span
                        className={`font-mono text-[12.5px] truncate ${
                          absoluteIdx === idx ? "text-fg" : "text-muted"
                        }`}
                      >
                        <Highlighted
                          text={tildify(h.path, home)}
                          query={query}
                        />
                      </span>
                      <span className="text-[11px] text-subtle shrink-0">
                        {timeAgo(h.lastUsed)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {sessionHits.length > 0 && (
              <div>
                <SectionHeader label="对话" count={sessionHits.length} />
                {sessionHits.map((h, i) => {
                  const absoluteIdx = projectHits.length + i;
                  return (
                    <button
                      key={h.session.sessionId}
                      onClick={() => pick(h)}
                      onMouseEnter={() => setIdx(absoluteIdx)}
                      className={`w-full text-left px-3 py-1.5 flex items-start gap-3 transition-colors ${
                        absoluteIdx === idx
                          ? "bg-blue/[0.15]"
                          : "hover:bg-fg/5"
                      }`}
                      title={h.title}
                    >
                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-[12.5px] truncate ${
                            absoluteIdx === idx ? "text-fg" : "text-muted"
                          }`}
                        >
                          <Highlighted text={h.title} query={query} />
                        </div>
                        {h.session.cwd && (
                          <div className="text-[10.5px] text-subtle font-mono truncate mt-0.5">
                            <Highlighted
                              text={tildify(h.session.cwd, home)}
                              query={query}
                            />
                          </div>
                        )}
                      </div>
                      <span className="text-[11px] text-subtle shrink-0 pt-0.5">
                        {timeAgo(h.session.lastModified)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {flat.length === 0 && (
              <div className="px-3 py-5 text-[12.5px] text-subtle text-center">
                {recents.length === 0 && sessions.length === 0
                  ? "还没有项目或对话"
                  : "无匹配"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="px-3 py-1 text-[10px] font-mono text-subtle uppercase tracking-[0.08em] flex items-center gap-2">
      <span>{label}</span>
      <span className="text-subtle/60">· {count}</span>
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
