import { useEffect, useMemo, useState } from "react";
import { getHome, tildify, timeAgo } from "../lib/fs";
import {
  listSessions,
  deleteSession as deleteSessionApi,
  type SessionSummary,
} from "../lib/sessions";
import {
  PROVIDER_OPTIONS,
  providerLabel,
  type AgentProvider,
} from "../lib/settings";
import { listGroups, deleteGroup } from "../lib/groups";
import type { GroupIndexRow } from "../lib/types";

interface Props {
  provider: AgentProvider;
  onProviderChange: (provider: AgentProvider) => void;
  onOpenSession: (s: SessionSummary) => void;
  onOpenProject: (cwd: string) => void;
  onClickOpen: () => void;
  onOpenGroup: (gid: string) => void;
  onCreateGroup: () => void;
  groupsRefreshKey?: number;
}

type ProjectGroup = {
  cwd: string;
  sessions: SessionSummary[];
  lastUsed: number;
};

export default function HomeView({
  provider,
  onProviderChange,
  onOpenSession,
  onOpenProject,
  onClickOpen,
  onOpenGroup,
  onCreateGroup,
  groupsRefreshKey,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [chatGroups, setChatGroups] = useState<GroupIndexRow[]>([]);
  const [home, setHome] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHome().then(setHome).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSessions(60, undefined, provider)
      .then(setSessions)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => {
    if (typeof location !== "undefined") {
      const p = location.port || (location.protocol === "https:" ? "443" : "80");
      setAddress(`${location.hostname}:${p}`);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    listGroups()
      .then((rows) => {
        if (!cancelled) setChatGroups(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [groupsRefreshKey]);

  const removeGroup = async (gid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("删除该群聊？历史会话不可恢复。")) return;
    await deleteGroup(gid);
    setChatGroups((gs) => gs.filter((g) => g.id !== gid));
  };

  const groups = useMemo<ProjectGroup[]>(() => {
    const byCwd = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      if (!s.cwd) continue;
      const arr = byCwd.get(s.cwd) ?? [];
      arr.push(s);
      byCwd.set(s.cwd, arr);
    }
    const out: ProjectGroup[] = [];
    for (const [cwd, list] of byCwd.entries()) {
      list.sort((a, b) => b.lastModified - a.lastModified);
      out.push({ cwd, sessions: list, lastUsed: list[0].lastModified });
    }
    out.sort((a, b) => b.lastUsed - a.lastUsed);
    return out;
  }, [sessions]);

  const onRemove = async (s: SessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSessionApi(s.sessionId, s.cwd, s.provider);
    setSessions((xs) =>
      xs.filter((x) => x.sessionId !== s.sessionId || x.provider !== s.provider)
    );
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-10 py-20">
        <Wordmark />
        <div className="flex items-center gap-2 text-[13px] text-muted mb-14 mt-1">
          <div className="w-1.5 h-1.5 rounded-full bg-green" />
          <span className="font-mono">{address}</span>
        </div>

        {chatGroups.length > 0 && (
          <div className="mb-10">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-fg text-[14.5px] font-semibold tracking-tight">
                群聊
              </h2>
              <button
                onClick={onCreateGroup}
                className="h-9 px-3.5 rounded-lg bg-surface border border-line-strong text-[12.5px] text-fg hover:bg-raised hover:border-fg/25 transition-colors flex items-center gap-2"
              >
                <PlusIcon />
                新建群聊
              </button>
            </div>
            <div className="border-t border-line">
              {chatGroups
                .slice()
                .sort((a, b) => b.lastTs - a.lastTs)
                .map((g) => (
                  <button
                    key={g.id}
                    onClick={() => onOpenGroup(g.id)}
                    className="group/g w-full text-left py-3 border-b border-line last:border-b-0 hover:bg-fg/[0.02] flex items-center gap-3"
                  >
                    <div className="flex items-center gap-2 shrink-0">
                      {g.inFlight && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-amber pulse-dot"
                          title="正在生成"
                        />
                      )}
                      <span className="text-[11px] font-mono text-subtle">
                        {g.participantSummary}
                      </span>
                    </div>
                    <span className="text-[13px] text-fg truncate flex-1">
                      {g.title}
                      {g.lastSnippet && (
                        <span className="ml-2 text-subtle text-[12px]">
                          — {g.lastSnippet}
                        </span>
                      )}
                    </span>
                    <span className="text-[11.5px] text-subtle shrink-0">
                      {timeAgo(g.lastTs)}
                    </span>
                    <button
                      onClick={(e) => removeGroup(g.id, e)}
                      aria-label="删除群聊"
                      className="opacity-0 group-hover/g:opacity-100 text-subtle hover:text-fg transition-opacity p-1"
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
                ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-fg text-[14.5px] font-semibold tracking-tight">
            最近项目
          </h2>
          <div className="flex items-center gap-2">
            <ProviderPicker value={provider} onChange={onProviderChange} />
            {chatGroups.length === 0 && (
              <button
                onClick={onCreateGroup}
                className="h-9 px-3.5 rounded-lg bg-surface border border-line-strong text-[12.5px] text-fg hover:bg-raised hover:border-fg/25 transition-colors flex items-center gap-2"
              >
                <PlusIcon />
                新建群聊
              </button>
            )}
            <button
              onClick={onClickOpen}
              className="h-9 px-3.5 rounded-lg bg-surface border border-line-strong text-[12.5px] text-fg hover:bg-raised hover:border-fg/25 transition-colors flex items-center gap-2"
            >
              <FolderIcon />
              打开项目
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-subtle text-[13px] py-6 border-t border-line">
            加载中…
          </div>
        ) : groups.length === 0 ? (
          <div className="text-muted text-[13px] py-6 border-t border-line">
            还没有 {providerLabel(provider)} 对话。点 "打开项目" 选一个文件夹开始。
          </div>
        ) : (
          <div className="border-t border-line">
            {groups.map((g) => (
              <ProjectBlock
                key={g.cwd}
                group={g}
                home={home}
                onOpenProject={onOpenProject}
                onOpenSession={onOpenSession}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const PROVIDER_ACCENT: Record<AgentProvider, string> = {
  claude: "#ef9d5a",
  codex: "#3ecf8e",
};

function ProviderPicker({
  value,
  onChange,
}: {
  value: AgentProvider;
  onChange: (provider: AgentProvider) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Agent provider"
      className="relative inline-flex items-stretch h-9 p-0.5 rounded-lg bg-canvas border border-line-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
    >
      {PROVIDER_OPTIONS.map((p) => {
        const active = p.id === value;
        const accent = PROVIDER_ACCENT[p.id];
        return (
          <button
            key={p.id}
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (!active) onChange(p.id);
            }}
            title={p.hint}
            className={`group relative flex items-center gap-2 px-3 rounded-md transition-all duration-200 ${
              active
                ? "bg-surface text-fg shadow-[0_1px_0_rgba(255,255,255,0.04),0_8px_18px_-12px_rgba(0,0,0,0.6)]"
                : "text-muted hover:text-fg"
            }`}
          >
            <span
              aria-hidden
              className="w-1.5 h-1.5 rounded-full transition-all duration-200"
              style={{
                background: active ? accent : "transparent",
                outline: active
                  ? `3px solid ${accent}22`
                  : `1px solid var(--color-line-strong)`,
                outlineOffset: 0,
              }}
            />
            <span
              className={`text-[12.5px] tracking-tight ${
                active ? "font-semibold" : "font-medium"
              }`}
            >
              {p.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ProjectBlock({
  group,
  home,
  onOpenProject,
  onOpenSession,
  onRemove,
}: {
  group: ProjectGroup;
  home: string;
  onOpenProject: (cwd: string) => void;
  onOpenSession: (s: SessionSummary) => void;
  onRemove: (s: SessionSummary, e: React.MouseEvent) => void;
}) {
  return (
    <div className="group/proj border-b border-line last:border-b-0 py-4">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => onOpenProject(group.cwd)}
          className="font-mono text-[13px] text-fg hover:text-fg transition-colors truncate text-left"
          title={group.cwd}
        >
          {tildify(group.cwd, home)}
        </button>
        <div className="flex items-center gap-3 shrink-0 pl-4">
          <span className="text-[11px] text-subtle">
            {group.sessions.length} 个对话
          </span>
          <button
            onClick={() => onOpenProject(group.cwd)}
            className="h-7 px-2.5 rounded-md text-[11.5px] text-muted hover:text-fg hover:bg-fg/5 border border-transparent hover:border-line-strong transition-colors opacity-0 group-hover/proj:opacity-100 flex items-center gap-1"
          >
            <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 2V12M2 7H12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            新对话
          </button>
        </div>
      </div>
      <div className="flex flex-col">
        {group.sessions.slice(0, 5).map((s) => (
          <button
            key={`${s.provider}:${s.sessionId}`}
            onClick={() => onOpenSession(s)}
            className="group/conv w-full flex items-center justify-between py-1.5 pl-4 pr-2 -mx-2 rounded text-left hover:bg-fg/[0.025] transition-colors min-w-0"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <span className="text-subtle shrink-0 font-mono text-[11px] select-none">
                └
              </span>
              <span className="text-[13px] text-muted group-hover/conv:text-fg truncate transition-colors">
                {s.customTitle || s.summary || s.firstPrompt || "（无摘要）"}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0 pl-3">
              <span className="text-[11.5px] text-subtle">
                {timeAgo(s.lastModified)}
              </span>
              <button
                onClick={(e) => onRemove(s, e)}
                aria-label="删除对话"
                className="opacity-0 group-hover/conv:opacity-100 text-subtle hover:text-fg transition-opacity p-1"
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
          </button>
        ))}
        {group.sessions.length > 5 && (
          <button
            onClick={() => onOpenProject(group.cwd)}
            className="text-left pl-4 pr-2 py-1.5 text-[12px] text-subtle hover:text-muted transition-colors"
          >
            查看全部 {group.sessions.length} 条 →
          </button>
        )}
      </div>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="inline-flex flex-col items-start select-none gap-1" aria-label="Web Code">
      <PixelRow text="WEB" size={56} />
      <PixelRow text="CODE" size={63} />
    </div>
  );
}

function PixelRow({ text, size }: { text: string; size: number }) {
  return (
    <div
      className="relative inline-block leading-none"
      style={{ fontSize: `${size}px` }}
    >
      <span className="pixel-shadow" aria-hidden>
        {text}
      </span>
      <span className="pixel-fill relative">{text}</span>
    </div>
  );
}

const FolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
    <path
      d="M1.5 4V11C1.5 11.55 1.95 12 2.5 12H11.5C12.05 12 12.5 11.55 12.5 11V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 3H2.5C1.95 3 1.5 3.45 1.5 4Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
    <path
      d="M7 2V12M2 7H12"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

