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
import Popover from "./Popover";

interface Props {
  provider: AgentProvider;
  onProviderChange: (provider: AgentProvider) => void;
  onOpenSession: (s: SessionSummary) => void;
  onOpenProject: (cwd: string) => void;
  onClickOpen: () => void;
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
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
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

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-fg text-[14.5px] font-semibold tracking-tight">
            最近项目
          </h2>
          <div className="flex items-center gap-2">
            <ProviderPicker value={provider} onChange={onProviderChange} />
            <button
              onClick={onClickOpen}
              className="h-8 px-3.5 rounded-md bg-surface border border-line-strong text-[12.5px] text-fg hover:bg-raised hover:border-fg/25 transition-colors flex items-center gap-2"
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

function ProviderPicker({
  value,
  onChange,
}: {
  value: AgentProvider;
  onChange: (provider: AgentProvider) => void;
}) {
  return (
    <Popover
      align="right"
      width={220}
      triggerClassName="h-8 px-3 rounded-md bg-canvas border border-line-strong text-[12px] text-fg hover:bg-raised hover:border-fg/25 transition-colors flex items-center gap-2"
      trigger={
        <>
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">
            Provider
          </span>
          <span className="font-mono text-[12px]">{providerLabel(value)}</span>
          <Caret />
        </>
      }
    >
      {({ close }) => (
        <div className="p-1">
          {PROVIDER_OPTIONS.map((p) => {
            const active = p.id === value;
            return (
              <button
                key={p.id}
                onClick={() => {
                  onChange(p.id);
                  close();
                }}
                className="w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-md text-left hover:bg-fg/5 transition-colors"
              >
                <div className="min-w-0">
                  <div
                    className={`font-mono text-[12.5px] ${
                      active ? "text-fg" : "text-muted"
                    }`}
                  >
                    {p.label}
                  </div>
                  <div className="text-[10.5px] text-subtle mt-0.5">
                    {p.hint}
                  </div>
                </div>
                {active && <div className="w-1.5 h-1.5 rounded-full bg-blue" />}
              </button>
            );
          })}
        </div>
      )}
    </Popover>
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
              <ProviderBadge provider={s.provider} />
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

function ProviderBadge({ provider }: { provider: AgentProvider }) {
  return (
    <span className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-subtle">
      {provider}
    </span>
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

const Caret = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    aria-hidden
  >
    <path
      d="M2.5 3.75L5 6.25L7.5 3.75"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
