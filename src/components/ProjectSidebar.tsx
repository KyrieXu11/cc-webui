import { useEffect, useId, useRef, useState } from "react";
import {
  listSessions,
  deleteSession as deleteSessionApi,
  type SessionSummary,
} from "../lib/sessions";
import { getInflightSessions } from "../lib/api";
import { tildify } from "../lib/fs";
import { providerLabel, type AgentProvider } from "../lib/settings";
import { createSessionListLoader, nextSessionWindow, RECENT_SESSION_COUNT, SESSION_LIST_POLL_MS, sortProjectSessions } from "../lib/project-sessions";
import { useAuth } from "../AuthGate";
import ShareSessionDialog from "./ShareSessionDialog";
import LiquidSelection from "./LiquidSelection";

const INFLIGHT_POLL_MS = 3000;
const PAGE_SIZE = 15;
const MAX_SESSIONS = 200;

interface Props {
  cwd: string;
  home: string;
  currentProvider: AgentProvider;
  currentSessionId: string | null;
  /** 删掉了一条会话（删成功之后才调）。App 用它判断删的是不是正开着的那条。 */
  onDeleted?: (s: SessionSummary) => void;
  /** Bump to force a re-fetch of the session list (e.g., after a turn ends). */
  refreshKey?: number;
  onNewChat: () => void;
  onOpenSession: (s: SessionSummary) => void;
}

function basename(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

// 两个人形。共享过的会话上常驻，被共享进来的会话上也常驻（配不同的 title）。
function ShareIcon({ className = "", label }: { className?: string; label?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="5.2" cy="4.6" r="2.1" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M1.6 11.4c0-1.9 1.6-3.2 3.6-3.2s3.6 1.3 3.6 3.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M9.8 3.1a2.1 2.1 0 0 1 0 4M10.4 8.4c1.4.35 2.2 1.4 2.2 3"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function ProjectSidebar({
  cwd,
  home,
  currentProvider,
  currentSessionId,
  onDeleted,
  refreshKey,
  onNewChat,
  onOpenSession,
}: Props) {
  const scope = `${currentProvider}\0${cwd}`;
  const [listing, setListing] = useState<{ scope: string; rows: SessionSummary[] }>({ scope: "", rows: [] });
  const sessions = listing.scope === scope ? listing.rows : [];
  const [page, setPage] = useState({ scope: "", size: PAGE_SIZE });
  const limit = page.scope === scope ? page.size : PAGE_SIZE;
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [inflight, setInflight] = useState<Set<string>>(() => new Set());
  const [sharing, setSharing] = useState<SessionSummary | null>(null);
  const [displayWindow, setWindow] = useState({ scope: "", size: RECENT_SESSION_COUNT });
  const visibleCount = displayWindow.scope === scope ? displayWindow.size : RECENT_SESSION_COUNT;
  const visibleSessions = sessions.slice(0, visibleCount);
  const revealCount = Math.min(RECENT_SESSION_COUNT, Math.max(0, sessions.length - visibleCount));
  const hasMore = sessions.length >= limit && limit < MAX_SESSIONS;
  const listId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const revealRef = useRef<{ scope: string; size: number; collapse?: boolean } | null>(null);
  const requestRef = useRef<ReturnType<typeof createSessionListLoader> | null>(null);
  const selectionRail = useRef<HTMLDivElement>(null);
  const listingRef = useRef(listing);
  listingRef.current = listing;
  const { isAdmin } = useAuth();

  // Poll for which sessions have an active SDK turn. Powers the pulsing dot
  // next to each entry so users can see "still generating" after switching
  // sessions or opening a new tab.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      getInflightSessions(currentProvider)
        .then((set) => {
          if (alive) setInflight(set);
        })
        .catch(() => {});
    };
    tick();
    const timer = setInterval(tick, INFLIGHT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [currentProvider]);

  useEffect(() => {
    setLoading(true);
    setError(false);
    const loader = createSessionListLoader({
      read: (signal) => listSessions(limit, cwd, currentProvider, { compact: true, signal }),
      onRows: (rows) => { setListing({ scope, rows: sortProjectSessions(rows) }); setError(false); },
      onError: () => setError(true),
      onSettled: () => setLoading(false),
    });
    requestRef.current = loader;
    // Background refreshes retain rows, the expanded window and scroll position.
    // Native CLI sessions (including other tabs) may appear after a turn starts.
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void loader.refresh();
    };
    void loader.refresh();
    const timer = setInterval(refreshVisible, SESSION_LIST_POLL_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      loader.dispose();
      if (requestRef.current === loader) requestRef.current = null;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [cwd, currentProvider, scope, limit, refreshKey, reload]);

  // A newly assigned native id should appear before the first reply finishes.
  // Merely selecting an existing row must not re-fetch or reset the list.
  useEffect(() => {
    const current = listingRef.current;
    if (currentSessionId && current.scope === scope &&
      !current.rows.some((s) => s.sessionId === currentSessionId && s.provider === currentProvider)) {
      setReload((n) => n + 1);
    }
  }, [currentSessionId, currentProvider, scope]);

  useEffect(() => {
    const reveal = revealRef.current;
    if (!reveal) return;
    if (reveal.scope !== scope) { revealRef.current = null; return; }
    if (reveal.size !== visibleCount) return;
    revealRef.current = null;
    if (reveal.collapse) {
      disclosureRef.current?.focus({ preventScroll: true });
      return;
    }
    const scroller = scrollRef.current;
    const lastRow = selectionRail.current?.querySelector<HTMLElement>(".conversation-row:last-child");
    if (!scroller || !lastRow) return;
    const footerHeight = footerRef.current?.getBoundingClientRect().height ?? 44;
    const delta = lastRow.getBoundingClientRect().bottom + footerHeight - scroller.getBoundingClientRect().bottom;
    if (delta > 0) scroller.scrollBy({ top: delta, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [scope, visibleCount]);

  const showMore = () => {
    if (loading || revealCount === 0) return;
    const size = nextSessionWindow(visibleCount, sessions.length);
    revealRef.current = { scope, size };
    setWindow({ scope, size });
    // Read ahead only after a click exhausts the known next five. Scrolling
    // alone never reveals or fetches more rows; the next button has a real count.
    if (hasMore && size + RECENT_SESSION_COUNT > sessions.length) {
      requestRef.current?.dispose();
      setLoading(true);
      setPage({ scope, size: Math.min(limit + PAGE_SIZE, MAX_SESSIONS) });
    }
  };

  const collapse = () => {
    revealRef.current = { scope, size: RECENT_SESSION_COUNT, collapse: true };
    setWindow({ scope, size: RECENT_SESSION_COUNT });
    scrollRef.current?.scrollTo({ top: 0 });
  };

  // 删成功才从列表里拿掉。乐观地先抹掉再说，会让「其实没删掉」一直到下次刷新才暴露。
  const remove = async (s: SessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteSessionApi(s.sessionId, s.cwd, s.provider);
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
      return;
    }
    // Abort a read begun before deletion, so its response cannot revive the row.
    requestRef.current?.dispose();
    setListing((current) => ({ ...current,
      rows: current.rows.filter((x) => x.sessionId !== s.sessionId || x.provider !== s.provider),
    }));
    setReload((n) => n + 1);
    onDeleted?.(s);
  };

  return (
    <aside className="session-sidebar shrink-0 flex flex-col">
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <div className="min-w-0 mb-3">
          <div className="text-fg text-[14px] font-semibold truncate">
            {basename(cwd)}
          </div>
          <div className="font-mono text-[11px] text-subtle truncate mt-0.5">
            {tildify(cwd, home)}
          </div>
        </div>
        <button
          onClick={onNewChat}
          className="soft-button w-full h-9 text-[12.5px] flex items-center justify-center gap-2"
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
          新建 {providerLabel(currentProvider)} 会话
        </button>
      </div>

      <div id={listId} ref={scrollRef} className="flex-1 overflow-x-hidden overflow-y-auto py-2 px-2">
        {(loading || listing.scope !== scope && !error) && sessions.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-subtle">加载中…</div>
        ) : sessions.length === 0 && !error ? (
          <div className="px-4 py-3 text-[12px] text-subtle">
            还没有对话，点 "新建会话" 开始。
          </div>
        ) : (
          <>
            <div key={scope} ref={selectionRail} className="conversation-selection-rail">
            <LiquidSelection
              container={selectionRail}
              activeKey={currentSessionId ? `${currentProvider}:${currentSessionId}` : null}
              layoutKey={visibleSessions.map(s => `${s.provider}:${s.sessionId}`).join("|")}
            />
            {visibleSessions.map((s) => {
              const active =
                s.sessionId === currentSessionId && s.provider === currentProvider;
              return (
                <div
                  key={`${s.provider}:${s.sessionId}`}
                  data-liquid-key={`${s.provider}:${s.sessionId}`}
                  title={
                    s.sharedBy
                      ? `${s.sharedBy} 共享给你的会话 —— 可以接着聊，但删不掉`
                      : s.sharedCount
                        ? `已共享给 ${s.sharedCount} 人`
                        : undefined
                  }
                  aria-current={active ? "true" : undefined}
                  className={`conversation-row group w-full text-left px-2.5 py-2.5 my-0.5 flex items-center gap-2 transition-colors min-w-0 ${
                    active
                      ? "text-fg"
                      : "text-muted hover:text-fg"
                  }`}
                >
                  <button
                    onClick={() => onOpenSession(s)}
                    className="flex flex-1 min-w-0 items-center gap-2 text-left"
                    aria-current={active ? "true" : undefined}
                  >
                    <div
                      className={`w-0.5 self-stretch rounded-sm shrink-0 ${
                        active ? "bg-blue" : "bg-transparent"
                      }`}
                    />
                    {inflight.has(s.sessionId) && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-amber pulse-dot shrink-0"
                        aria-label="正在生成"
                        title="该会话有活跃的 SDK 对话"
                      />
                    )}
                    <span className="text-[12.5px] truncate flex-1">
                      {s.customTitle || s.summary || s.firstPrompt || "（无摘要）"}
                    </span>
                    {/* 常驻标记。只在**有动作按钮要顶上来**时 hover 隐藏，
                        否则一行挤三个图标；被共享进来的行没有动作按钮，
                        藏掉它只会让标记在鼠标下凭空消失。 */}
                    {(() => {
                      const canManage = !!s.mine || isAdmin;
                      const hideOnHover = canManage ? " group-hover:hidden group-focus-within:hidden" : "";
                      if (s.sharedBy) {
                        return (
                          <ShareIcon
                            className={`text-blue shrink-0${hideOnHover}`}
                            label={`由 ${s.sharedBy} 共享`}
                          />
                        );
                      }
                      if (!s.sharedCount) return null;
                      return (
                        <ShareIcon
                          className={`text-subtle shrink-0${hideOnHover}`}
                          label={`已共享给 ${s.sharedCount} 人`}
                        />
                      );
                    })()}
                  </button>
                  {/* 共享是**管理员专属**（决策 41）；删除是「自己的（或管理员）」——
                      两条守卫不一样，别合并。真正拦住的都是服务端：共享那三条是
                      `auth: "admin"`，DELETE 是不带 access 的 owns。 */}
                  {isAdmin && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSharing(s);
                      }}
                      aria-label="共享"
                      title="共享给其他人 / 转交归属"
                      className="hidden group-hover:block group-focus-within:block max-md:block text-subtle hover:text-fg transition-colors shrink-0"
                    >
                      <ShareIcon />
                    </button>
                  )}
                  {(s.mine || isAdmin) && (
                    <button
                      onClick={(e) => remove(s, e)}
                      aria-label="删除"
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-subtle hover:text-fg transition-opacity shrink-0"
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
                  )}
                </div>
              );
            })}
            </div>
            <div ref={footerRef} className="conversation-list-footer">
              {revealCount > 0 ? <button
                ref={disclosureRef}
                onClick={showMore}
                disabled={loading}
                className="conversation-disclosure"
                aria-controls={listId}
                aria-label={`展开显示 ${revealCount} 个对话`}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>展开显示</span><span className="tabular-nums">{revealCount}</span>
              </button> : loading && <span className="px-2 py-2 text-[12px] text-muted" role="status">加载中…</span>}
              {visibleCount > RECENT_SESSION_COUNT && <button
                onClick={collapse}
                className="conversation-disclosure conversation-collapse"
                aria-controls={listId}
                aria-label="收起更早对话"
              >收起</button>}
            </div>
          </>
        )}
        {error && <div role="status" className="px-4 py-3 text-[12px] text-muted">
          对话列表加载失败。<button onClick={() => setReload((n) => n + 1)} className="ml-2 text-fg">重试</button>
        </div>}
      </div>

      {sharing && (
        <ShareSessionDialog
          sessionId={sharing.sessionId}
          provider={sharing.provider}
          label={
            sharing.customTitle || sharing.summary || sharing.firstPrompt || undefined
          }
          onClose={() => setSharing(null)}
          onChanged={() => {
            // 名单或归属变了就重拉：转交出去之后这一行可能整条消失。
            setReload((n) => n + 1);
          }}
        />
      )}
    </aside>
  );
}
