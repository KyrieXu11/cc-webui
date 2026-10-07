import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getHome, tildify, timeAgo } from "../lib/fs";
import {
  listSessions,
  deleteSession as deleteSessionApi,
  SEARCH_WINDOW,
  type SessionSummary,
} from "../lib/sessions";
import Highlighted from "./Highlighted";
import {
  PROVIDER_OPTIONS,
  providerLabel,
  type AgentProvider,
} from "../lib/settings";
import { listGroups, deleteGroup } from "../lib/groups";
import { useAuth } from "../AuthGate";
import { useIsNarrow } from "../lib/useIsNarrow";
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
  groupsEnabled?: boolean;
}

type ProjectGroup = {
  cwd: string;
  /** 搜索时这里只放**命中的**会话；不搜索时是这个项目的全部。 */
  sessions: SessionSummary[];
  lastUsed: number;
  /** 这一块是因为**项目路径**命中才留下的（而不是某条会话的标题）。 */
  pathHit: boolean;
};

/** 默认每个项目下面列几条；搜索时放宽 —— 那些行本身就是搜索结果。 */
const SESSIONS_PER_PROJECT = 5;
const SESSIONS_PER_PROJECT_SEARCHING = 12;

const HOTKEY = /Mac|iP(hone|ad|od)/.test(
  typeof navigator === "undefined" ? "" : navigator.userAgent
)
  ? "⌘K"
  : "^K";

const titleOf = (s: SessionSummary) =>
  s.customTitle || s.summary || s.firstPrompt || "（无摘要）";

export default function HomeView({
  provider,
  onProviderChange,
  onOpenSession,
  onOpenProject,
  onClickOpen,
  onOpenGroup,
  onCreateGroup,
  groupsRefreshKey,
  groupsEnabled = false,
}: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [chatGroups, setChatGroups] = useState<GroupIndexRow[]>([]);
  const [home, setHome] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  // 搜索用的全量窗口。**首屏不拉**：默认视图叫「最近项目」，只要 60 条，而全量是
  // ~677ms 的磁盘活儿（见 SEARCH_WINDOW）。聚焦搜索框才拉，这样它和用户打字并行。
  const [allSessions, setAllSessions] = useState<SessionSummary[] | null>(null);
  const [wideLoading, setWideLoading] = useState(false);
  const wideFor = useRef<AgentProvider | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadWide = useCallback(() => {
    if (wideFor.current === provider) return;
    wideFor.current = provider;
    setWideLoading(true);
    listSessions(SEARCH_WINDOW, undefined, provider)
      .then(setAllSessions)
      .catch(() => {
        wideFor.current = null; // 失败就让下次聚焦重试，别永久退化成 60 条
      })
      .finally(() => setWideLoading(false));
  }, [provider]);

  // 换 provider → 上一批不作数（首页列表本来就是按 provider 过滤的）。
  useEffect(() => {
    wideFor.current = null;
    setAllSessions(null);
  }, [provider]);

  // ⌘K / ^K 聚焦搜索框，照律枢侧栏那颗「搜索 ⌘K」。只在首页挂着，所以不会和
  // App 里的 Ctrl-O / Ctrl-B 抢。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    // /api/groups isn't mounted when the feature is off — skip the 404.
    if (!groupsEnabled) {
      setChatGroups([]);
      return;
    }
    let cancelled = false;
    listGroups()
      .then((rows) => {
        if (!cancelled) setChatGroups(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [groupsRefreshKey, groupsEnabled]);

  const removeGroup = async (gid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("删除该群聊？历史会话不可恢复。")) return;
    await deleteGroup(gid);
    setChatGroups((gs) => gs.filter((g) => g.id !== gid));
  };

  const kw = query.trim().toLowerCase();
  const searching = kw !== "";
  // 搜索时用全量窗口（还没拉到就先拿最近这 60 条顶着，界面上会说明范围）；
  // 不搜索时永远只是「最近」那 60 条 —— 清空搜索框应该回到首屏，而不是留着 786 行。
  const pool = searching ? (allSessions ?? sessions) : sessions;

  // 「搜索项目」和「搜索会话」是同一个框：
  //   · 关键词命中**项目路径** → 整块留下（连它的会话一起，那就是「这个项目」）；
  //   · 只命中**会话标题** → 这块只留命中的那几条。
  const groups = useMemo<ProjectGroup[]>(() => {
    const byCwd = new Map<string, SessionSummary[]>();
    for (const s of pool) {
      if (!s.cwd) continue;
      const arr = byCwd.get(s.cwd) ?? [];
      arr.push(s);
      byCwd.set(s.cwd, arr);
    }
    const out: ProjectGroup[] = [];
    for (const [cwd, list] of byCwd.entries()) {
      list.sort((a, b) => b.lastModified - a.lastModified);
      if (!kw) {
        out.push({
          cwd,
          sessions: list,
          lastUsed: list[0].lastModified,
          pathHit: false,
        });
        continue;
      }
      // ⚠️ **按屏幕上那个写法比（`~/code/x`），不按绝对路径。** 拿绝对路径比会让
      // `/Users/<你>/` 这一段跟着参与匹配 —— 搜 "users"、搜自己的用户名，全部项目
      // 一个不落地命中；实测搜 "OA" 会因为 "l-oa-ds" 把 ~/Downloads 那个项目捞出来。
      // 只有关键词本身就是绝对路径（粘贴进来的）时才比原文。
      const pathHit =
        tildify(cwd, home).toLowerCase().includes(kw) ||
        (kw.startsWith("/") && cwd.toLowerCase().includes(kw));
      const hits = pathHit
        ? list
        : list.filter((s) => titleOf(s).toLowerCase().includes(kw));
      if (hits.length === 0) continue;
      out.push({
        cwd,
        sessions: hits,
        lastUsed: hits[0].lastModified,
        pathHit,
      });
    }
    out.sort((a, b) => b.lastUsed - a.lastUsed);
    return out;
  }, [pool, kw, home]);

  const matchedSessions = useMemo(
    () => groups.reduce((n, g) => n + g.sessions.length, 0),
    [groups]
  );

  // 群聊也一起过滤：一个框管一页，不然搜出来的项目下面还挂着一堆无关群聊。
  // 路径同上，比屏幕上那个写法，不比绝对路径。
  const visibleChatGroups = useMemo(() => {
    const rows = chatGroups.slice().sort((a, b) => b.lastTs - a.lastTs);
    if (!kw) return rows;
    return rows.filter(
      (g) =>
        `${g.title} ${tildify(g.cwd, home)} ${g.lastSnippet ?? ""}`
          .toLowerCase()
          .includes(kw) ||
        (kw.startsWith("/") && g.cwd.toLowerCase().includes(kw))
    );
  }, [chatGroups, kw, home]);

  // 回车打开「第一条结果」：那一块是因为路径命中留下的就开项目，否则开它第一条命中会话。
  const openTopHit = () => {
    const g = groups[0];
    if (!g) return;
    if (g.pathHit) onOpenProject(g.cwd);
    else if (g.sessions[0]) onOpenSession(g.sessions[0]);
  };

  // 同 ProjectSidebar：删成功才从列表里拿掉（见 lib/sessions.ts 里那段注释）。
  const onRemove = async (s: SessionSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteSessionApi(s.sessionId, s.cwd, s.provider);
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
      return;
    }
    const gone = (x: SessionSummary) =>
      x.sessionId !== s.sessionId || x.provider !== s.provider;
    setSessions((xs) => xs.filter(gone));
    setAllSessions((xs) => (xs ? xs.filter(gone) : xs));
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[960px] mx-auto px-10 py-12 max-md:px-5 max-md:pt-8 max-md:pb-8">
        <Wordmark />
        <div className="flex items-center gap-2 text-[13px] text-muted mb-10 max-md:mb-8 mt-2">
          <div className="w-1.5 h-1.5 rounded-full bg-green" />
          <span className="font-mono">{address}</span>
        </div>

        {visibleChatGroups.length > 0 && (
          <div className="mb-10">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-fg text-[14.5px] font-semibold tracking-tight">
                  群聊
                </h2>
                <span className="text-[10px] font-mono text-subtle uppercase tracking-[0.1em]">
                  multi-agent
                </span>
              </div>
              <button
                onClick={onCreateGroup}
                className="h-9 px-3.5 soft-button text-[12.5px] flex items-center gap-2"
              >
                <PlusIcon />
                新建群聊
              </button>
            </div>
            <div className="soft-panel px-4 py-1">
              {visibleChatGroups.map((g) => (
                  <div
                    key={g.id}
                    className="group/g flex items-center gap-3 py-3 border-b border-line last:border-b-0 hover:bg-fg/[0.025] transition-colors px-1 -mx-1 rounded"
                  >
                    <button
                      onClick={() => onOpenGroup(g.id)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-1.5 shrink-0 w-[68px]">
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{
                            background: "var(--color-provider-claude)",
                            outline: "3px solid color-mix(in srgb, var(--color-provider-claude) 12%, transparent)",
                          }}
                        />
                        <span className="text-subtle/40 text-[10px]">×</span>
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{
                            background: "var(--color-provider-codex)",
                            outline: "3px solid color-mix(in srgb, var(--color-provider-codex) 12%, transparent)",
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
                        <div className="flex items-baseline gap-2 min-w-0">
                          <span className="text-[13.5px] text-fg font-medium tracking-tight truncate">
                            {g.title}
                          </span>
                          <span className="font-mono text-[10.5px] text-subtle shrink-0">
                            {tildify(g.cwd, home)}
                          </span>
                        </div>
                        {g.lastSnippet && (
                          <span className="text-[12px] text-subtle truncate mt-0.5">
                            {g.lastSnippet}
                          </span>
                        )}
                      </div>
                    </button>
                    <span className="text-[11.5px] text-subtle shrink-0 font-mono">
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
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* ⚠️ `flex-wrap` + 按钮组 `ml-auto`：窄屏上标题和搜索框占第一行、按钮掉到
            第二行靠右，不会把搜索框挤成一条缝（`<input>` 有 ~46px 的内在最小宽度，
            光给 min-w-0 是压不住的，HeaderSearch 那边为此栽过一次）。 */}
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <h2 className="text-fg text-[14.5px] font-semibold tracking-tight shrink-0">
            最近项目
          </h2>
          <SearchField
            inputRef={searchRef}
            value={query}
            onChange={setQuery}
            onFocus={loadWide}
            onEnter={openTopHit}
          />
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            <ProviderPicker value={provider} onChange={onProviderChange} />
            {groupsEnabled && chatGroups.length === 0 && (
              <button
                onClick={onCreateGroup}
                className="h-9 px-3.5 soft-button text-[12.5px] flex items-center gap-2"
              >
                <PlusIcon />
                新建群聊
              </button>
            )}
            <button
              onClick={onClickOpen}
              className="h-9 px-3.5 soft-button text-[12.5px] flex items-center gap-2"
            >
              <FolderIcon />
              打开项目
            </button>
          </div>
        </div>

        {/* 搜索范围要写出来。默认只装最近 60 条，全量还在路上时结果是不完整的 ——
            不说清楚，用户会把「还没装完」读成「这东西没了」。 */}
        {searching && (
          <div className="flex items-baseline gap-2.5 flex-wrap pb-2 text-[11.5px]">
            <span className="text-muted">
              匹配 {groups.length} 个项目 · {matchedSessions} 个对话
            </span>
            <span className="text-subtle">
              {wideLoading
                ? `正在装入全部对话…（现在只搜了最近 ${sessions.length} 个）`
                : allSessions
                  ? `搜索范围：全部 ${allSessions.length} 个对话`
                  : `搜索范围：最近 ${sessions.length} 个对话`}
            </span>
          </div>
        )}

        {loading ? (
          <div className="soft-empty text-subtle text-[13px]">
            加载中…
          </div>
        ) : groups.length === 0 ? (
          <div className="soft-empty text-muted text-[13px]">
            {searching
              ? `没有匹配「${query.trim()}」的项目或对话。`
              : `还没有 ${providerLabel(provider)} 对话。点 "打开项目" 选一个文件夹开始。`}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <ProjectBlock
                key={g.cwd}
                group={g}
                home={home}
                query={query}
                cap={
                  searching
                    ? SESSIONS_PER_PROJECT_SEARCHING
                    : SESSIONS_PER_PROJECT
                }
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
  claude: "var(--color-provider-claude)",
  codex: "var(--color-provider-codex)",
};

function ProviderPicker({
  value,
  onChange,
}: {
  value: AgentProvider;
  onChange: (provider: AgentProvider) => void;
}) {
  const { allowedProviders } = useAuth();
  // The server publishes this account's explicit grants.
  const options = PROVIDER_OPTIONS.filter((p) => allowedProviders.includes(p.id));
  if (options.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label="Agent provider"
      className="soft-segmented relative inline-flex items-stretch h-9"
    >
      {options.map((p) => {
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
            className="soft-segment group relative flex items-center gap-2 px-3"
          >
            <span
              aria-hidden
              className="w-1.5 h-1.5 rounded-full transition-all duration-200"
              style={{
                background: active ? accent : "transparent",
                outline: active
                  ? `3px solid color-mix(in srgb, ${accent} 12%, transparent)`
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

// 搜索框长在「最近项目」这一行的表头上（不是浮层）。**这一页本身就是结果列表** ——
// 项目分组、会话行、删除按钮、「查看全部」全都在，就地收窄比另开一层覆盖它更省事。
// 浮层那一版在项目内的顶栏里（`HeaderSearch`），两处行为一致：分组、命中高亮、Esc。
function SearchField({
  inputRef,
  value,
  onChange,
  onFocus,
  onEnter,
}: {
  inputRef: React.Ref<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  /** 聚焦即开始拉全量窗口，这样它和用户打字并行，不是打完再等 677ms。 */
  onFocus: () => void;
  onEnter: () => void;
}) {
  return (
    <div className="relative flex-1 min-w-[180px] max-w-[300px]">
      <svg
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none"
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
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Escape") {
            e.preventDefault();
            // 先清词，已经空了才让焦点走 —— Esc 的第一意图是「撤销这次筛选」。
            if (value) onChange("");
            else e.currentTarget.blur();
          }
        }}
        placeholder="搜索项目或对话"
        aria-label="搜索项目或对话"
        className="soft-input w-full min-w-0 h-9 pl-8 pr-12 text-[12.5px] placeholder:text-subtle"
      />
      {/* ⚠️ **预加载不许有可见的加载指示。** 曾经在这儿放过一个转圈：全量窗口是聚焦时
          就开始拉的（788 个会话 677ms+），于是「鼠标点进框里、一个字没输」就开始转 ——
          用户没让它干活，它却在忙，这指示器对他毫无意义，只有干扰（真机反馈原话：
          「我怎么鼠标放上去就转圈了」）。装入状态归下面那条「搜索范围」行：**那条只在
          真的在搜的时候才出现**，也只有那时候「范围不全」才是个需要告知的事实。 */}
      <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center">
        {value ? (
          <button
            onClick={() => onChange("")}
            aria-label="清空搜索"
            className="text-subtle hover:text-fg p-1 rounded"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path
                d="M3 3L9 9M9 3L3 9"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : (
          <span className="font-mono text-[10px] text-subtle border border-line rounded px-1 py-px select-none">
            {HOTKEY}
          </span>
        )}
      </div>
    </div>
  );
}

function ProjectBlock({
  group,
  home,
  query,
  cap,
  onOpenProject,
  onOpenSession,
  onRemove,
}: {
  group: ProjectGroup;
  home: string;
  /** 只用来画高亮；过不过滤是上面决定的。 */
  query: string;
  cap: number;
  onOpenProject: (cwd: string) => void;
  onOpenSession: (s: SessionSummary) => void;
  onRemove: (s: SessionSummary, e: React.MouseEvent) => void;
}) {
  const { isAdmin } = useAuth();
  const searching = query.trim() !== "";
  return (
    <div className="soft-panel group/proj px-5 py-4 max-md:px-4">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => onOpenProject(group.cwd)}
          className="font-mono font-medium text-[13px] text-fg hover:text-blue transition-colors truncate text-left"
          title={group.cwd}
        >
          <Highlighted text={tildify(group.cwd, home)} query={query} />
        </button>
        <div className="flex items-center gap-3 shrink-0 pl-4">
          <span className="text-[11px] text-subtle">
            {searching && !group.pathHit
              ? `命中 ${group.sessions.length} 个对话`
              : `${group.sessions.length} 个对话`}
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
        {group.sessions.slice(0, cap).map((s) => (
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
                <Highlighted text={titleOf(s)} query={query} />
              </span>
              {s.sharedBy && (
                <span
                  className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.1em] text-blue border border-blue/40 rounded px-1 py-px"
                  title={`${s.sharedBy} 共享给你的会话 —— 可以接着聊，但删不掉`}
                >
                  共享
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 pl-3">
              <span className="text-[11.5px] text-subtle">
                {timeAgo(s.lastModified)}
              </span>
              {/* 共享进来的会话删不掉（policy 里 DELETE 是 owner 级），所以按钮
                  直接不画：留着就是一个点了只会弹错的 X。（deleteSession 现在会
                  如实抛错了，但"看得见却删不掉"本身仍然只该出现在意外路径上。） */}
              {(s.mine || isAdmin) && (
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
              )}
            </div>
          </button>
        ))}
        {group.sessions.length > cap && (
          <button
            onClick={() => onOpenProject(group.cwd)}
            className="text-left pl-4 pr-2 py-1.5 text-[12px] text-subtle hover:text-muted transition-colors"
          >
            {searching && !group.pathHit
              ? `还有 ${group.sessions.length - cap} 条命中 → 打开项目`
              : `查看全部 ${group.sessions.length} 条 →`}
          </button>
        )}
      </div>
    </div>
  );
}

function Wordmark() {
  // 56/63px 在 390 宽的屏上要吃掉四成屏高，首屏就只剩一条项目列表。
  const narrow = useIsNarrow();
  const [a, b] = narrow ? [34, 38] : [56, 63];
  return (
    <div className="inline-flex flex-col items-start select-none gap-1" aria-label="Web Code">
      <PixelRow text="WEB" size={a} />
      <PixelRow text="CODE" size={b} />
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
