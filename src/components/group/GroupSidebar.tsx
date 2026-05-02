import { useEffect, useState } from "react";
import { listGroups, deleteGroup } from "../../lib/groups";
import { tildify } from "../../lib/fs";
import type { GroupIndexRow } from "../../lib/types";

const POLL_MS = 3000;
const CLAUDE_ACCENT = "#ef9d5a";
const CODEX_ACCENT = "#3ecf8e";

interface Props {
  home: string;
  currentGroupId: string | null;
  refreshKey?: number;
  onOpenGroup: (gid: string) => void;
  onCreateGroup: () => void;
}

export default function GroupSidebar({
  home,
  currentGroupId,
  refreshKey,
  onOpenGroup,
  onCreateGroup,
}: Props) {
  const [groups, setGroups] = useState<GroupIndexRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const fetch = () =>
      listGroups()
        .then((rows) => {
          if (!alive) return;
          rows.sort((a, b) => b.lastTs - a.lastTs);
          setGroups(rows);
        })
        .catch(() => {})
        .finally(() => alive && setLoading(false));
    fetch();
    const timer = setInterval(fetch, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refreshKey]);

  const remove = async (gid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("删除该群聊？历史会话不可恢复。")) return;
    await deleteGroup(gid);
    setGroups((gs) => gs.filter((g) => g.id !== gid));
  };

  return (
    <aside className="w-[260px] shrink-0 border-r border-line flex flex-col bg-canvas">
      <div className="px-4 pt-4 pb-3 border-b border-line">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex -space-x-1">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: CLAUDE_ACCENT,
                outline: `2px solid var(--color-canvas)`,
              }}
            />
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: CODEX_ACCENT,
                outline: `2px solid var(--color-canvas)`,
              }}
            />
          </div>
          <div className="text-fg text-[14px] font-semibold tracking-tight">
            群聊
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle ml-auto">
            multi-agent
          </span>
        </div>
        <button
          onClick={onCreateGroup}
          className="w-full h-9 rounded-md bg-raised border border-line-strong text-[12.5px] text-fg hover:border-fg/25 hover:bg-fg/5 transition-colors flex items-center justify-center gap-2"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path
              d="M7 2V12M2 7H12"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          新建群聊
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="px-4 py-3 text-[12px] text-subtle font-mono">加载中…</div>
        ) : groups.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-subtle">
            还没有群聊，点 "新建群聊" 开始。
          </div>
        ) : (
          groups.map((g) => {
            const active = g.id === currentGroupId;
            return (
              <div
                key={g.id}
                className={`group/g flex items-center gap-2 transition-colors min-w-0 ${
                  active
                    ? "bg-surface text-fg"
                    : "text-muted hover:text-fg hover:bg-fg/[0.02]"
                }`}
              >
                <button
                  onClick={() => onOpenGroup(g.id)}
                  className="flex-1 text-left px-3.5 py-2 flex items-center gap-2.5 min-w-0"
                >
                  <div
                    className={`w-0.5 self-stretch rounded-sm shrink-0 ${
                      active ? "bg-blue" : "bg-transparent"
                    }`}
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        background: CLAUDE_ACCENT,
                        outline: `3px solid ${CLAUDE_ACCENT}22`,
                      }}
                    />
                    <span className="text-subtle/40 text-[9px] mx-px">×</span>
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        background: CODEX_ACCENT,
                        outline: `3px solid ${CODEX_ACCENT}22`,
                      }}
                    />
                    {g.inFlight && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-amber pulse-dot ml-1"
                        title="正在生成"
                      />
                    )}
                  </div>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span
                      className={`text-[12.5px] truncate ${
                        active ? "text-fg" : ""
                      }`}
                    >
                      {g.title}
                    </span>
                    <span className="font-mono text-[10px] text-subtle/70 truncate">
                      {tildify(g.cwd, home)}
                    </span>
                  </div>
                </button>
                <button
                  onClick={(e) => remove(g.id, e)}
                  aria-label="删除"
                  className="opacity-0 group-hover/g:opacity-100 text-subtle hover:text-fg transition-opacity shrink-0 px-2"
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
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
