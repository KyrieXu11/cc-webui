import { useEffect, useRef, useState } from "react";
import {
  listSessions,
  deleteSession as deleteSessionApi,
  type SessionSummary,
} from "../lib/sessions";
import { tildify } from "../lib/fs";

interface Props {
  cwd: string;
  home: string;
  currentSessionId: string | null;
  onNewChat: () => void;
  onOpenSession: (s: SessionSummary) => void;
}

function basename(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

export default function ProjectSidebar({
  cwd,
  home,
  currentSessionId,
  onNewChat,
  onOpenSession,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [limit, setLimit] = useState(15);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSessions(200, cwd)
      .then((xs) => {
        if (cancelled) return;
        setSessions(xs);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [cwd, currentSessionId]);

  useEffect(() => {
    if (sessions.length <= limit) return;
    const el = loaderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setLimit((l) => Math.min(l + 15, sessions.length));
        }
      },
      { root: el.parentElement, threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sessions.length, limit]);

  const shown = sessions.slice(0, limit);

  const remove = async (s: SessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSessionApi(s.sessionId, s.cwd);
    setSessions((xs) => xs.filter((x) => x.sessionId !== s.sessionId));
  };

  return (
    <aside className="w-[260px] shrink-0 border-r border-line flex flex-col bg-canvas">
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <div className="text-fg text-[14px] font-semibold truncate">
              {basename(cwd)}
            </div>
            <div className="font-mono text-[11px] text-subtle truncate mt-0.5">
              {tildify(cwd, home)}
            </div>
          </div>
          <button
            aria-label="更多"
            className="p-1 rounded text-subtle hover:text-fg hover:bg-fg/5 transition-colors shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="2.5" cy="7" r="1" fill="currentColor" />
              <circle cx="7" cy="7" r="1" fill="currentColor" />
              <circle cx="11.5" cy="7" r="1" fill="currentColor" />
            </svg>
          </button>
        </div>
        <button
          onClick={onNewChat}
          className="w-full h-9 rounded-md bg-raised border border-line-strong text-[12.5px] text-fg hover:border-fg/25 hover:bg-fg/5 transition-colors flex items-center justify-center gap-2"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path
              d="M3 2.5H9L11.5 5V11C11.5 11.55 11.05 12 10.5 12H3.5C2.95 12 2.5 11.55 2.5 11V3C2.5 2.45 2.95 2 3.5 2"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M7 6V10M5 8H9"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
          新建会话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="px-4 py-3 text-[12px] text-subtle">加载中…</div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-subtle">
            还没有对话，点 "新建会话" 开始。
          </div>
        ) : (
          <>
            {shown.map((s) => {
              const active = s.sessionId === currentSessionId;
              return (
                <button
                  key={s.sessionId}
                  onClick={() => onOpenSession(s)}
                  className={`group w-full text-left px-3.5 py-2 flex items-center gap-2 transition-colors min-w-0 ${
                    active
                      ? "bg-surface text-fg"
                      : "text-muted hover:text-fg hover:bg-fg/[0.02]"
                  }`}
                >
                  <div
                    className={`w-0.5 self-stretch rounded-sm shrink-0 ${
                      active ? "bg-blue" : "bg-transparent"
                    }`}
                  />
                  <span className="text-[12.5px] truncate flex-1">
                    {s.customTitle || s.summary || s.firstPrompt || "（无摘要）"}
                  </span>
                  <button
                    onClick={(e) => remove(s, e)}
                    aria-label="删除"
                    className="opacity-0 group-hover:opacity-100 text-subtle hover:text-fg transition-opacity shrink-0"
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M3 3L9 9M9 3L3 9"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </button>
              );
            })}
            {sessions.length > limit && (
              <div
                ref={loaderRef}
                className="flex items-center justify-center py-3 text-[11px] text-subtle font-mono gap-1.5"
              >
                <span className="w-1 h-1 rounded-full bg-subtle animate-pulse" />
                加载中…
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
