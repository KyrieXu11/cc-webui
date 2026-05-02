import { useEffect, useMemo, useRef, useState } from "react";
import MessageList from "../MessageList";
import ParticipantsBar from "./ParticipantsBar";
import GroupComposer from "./GroupComposer";
import GroupConfigDialog from "./GroupConfigDialog";
import TasksButton from "../TasksButton";
import TasksModal from "../TasksModal";
import {
  attachGroupStream,
  fetchGroup,
  stopGroupTurn,
  streamGroupTurn,
  updateGroupConfig,
} from "../../lib/groups";
import { sendPermission } from "../../lib/permission";
import { applySDKMessage } from "../../lib/processor";
import { tildify } from "../../lib/fs";
import type {
  ChatEvent,
  GroupAgentId,
  GroupConfig,
  GroupParticipant,
  GroupQuote,
  GroupSseEvent,
  GroupTurnEntry,
  PermissionDecision,
} from "../../lib/types";

const AGENT_ACCENT: Record<GroupAgentId, string> = {
  claude: "#ef9d5a",
  codex: "#3ecf8e",
};

type Block =
  | { kind: "user"; entry: GroupTurnEntry }
  | {
      kind: "agent";
      agent: GroupAgentId;
      events: ChatEvent[];
      isLive: boolean;
      pipelineStep?: number;
    };

type Props = {
  gid: string;
  home: string;
  onBack: () => void;
};

export default function GroupChatView({ gid, home, onBack }: Props) {
  const [config, setConfig] = useState<GroupConfig | null>(null);
  const [messages, setMessages] = useState<GroupTurnEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [activeAgent, setActiveAgent] = useState<GroupAgentId | null>(null);
  const [liveByAgent, setLiveByAgent] = useState<
    Partial<Record<GroupAgentId, ChatEvent[]>>
  >({});
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [quote, setQuote] = useState<GroupQuote | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const tasksScope = useMemo(
    () => ({ sessionPrefix: `${gid}:` }),
    [gid],
  );
  const turnAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const forceBottomRef = useRef(false);

  // Initial load + attach if in-flight
  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setMessages([]);
    setLiveByAgent({});
    setActiveAgent(null);
    setRunning(false);
    setError(null);
    forceBottomRef.current = true;
    fetchGroup(gid)
      .then((r) => {
        if (cancelled) return;
        setConfig(r.config);
        setMessages(r.messages);
        if (r.inFlight) {
          setRunning(true);
          attachToLive();
        }
      })
      .catch((err) => !cancelled && setError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
      turnAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gid]);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (forceBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      forceBottomRef.current = false;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, liveByAgent, running]);

  // Ctrl+O global expand/collapse for thinking + steps (matches single chat)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "o") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        const ids = new Set<string>();
        for (const buf of Object.values(liveByAgent)) {
          for (const ev of buf ?? []) {
            if (ev.type === "step" || ev.type === "thinking") ids.add(ev.id);
          }
        }
        for (const m of messages) {
          if (m.event.type === "step" || m.event.type === "thinking") {
            ids.add(m.event.id);
          }
        }
        setExpandedSteps((prev) => (prev.size > 0 ? new Set() : ids));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [messages, liveByAgent]);

  function applyEvent(ev: GroupSseEvent) {
    if (ev.type === "turn_begin") {
      setRunning(true);
      setLiveByAgent({});
      setActiveAgent(null);
      const optimistic: GroupTurnEntry = {
        agent: "user",
        ts: Date.now(),
        event: {
          id: `optimistic-${ev.turnId}`,
          type: "user",
          text: ev.userText,
        },
        meta: {
          turnId: ev.turnId,
          recipients: ev.recipients,
          quote: ev.quote,
        },
      };
      setMessages((prev) =>
        prev.some((m) => m.event.id === optimistic.event.id)
          ? prev
          : [...prev, optimistic],
      );
    }
    if (ev.type === "agent_begin") {
      setActiveAgent(ev.agent);
      setLiveByAgent((s) => ({ ...s, [ev.agent]: [] }));
    }
    if (ev.type === "agent_event") {
      setLiveByAgent((s) => {
        const cur = s[ev.agent] ?? [];
        const next = applySDKMessage(cur, ev.payload, () => {});
        if (next === cur) return s;
        return { ...s, [ev.agent]: next };
      });
    }
    if (ev.type === "agent_end") {
      fetchGroup(gid)
        .then((r) => {
          setMessages(r.messages);
          setLiveByAgent((s) => {
            const next = { ...s };
            delete next[ev.agent];
            return next;
          });
        })
        .catch(() => {});
    }
    if (ev.type === "turn_end") {
      setRunning(false);
      setActiveAgent(null);
      fetchGroup(gid)
        .then((r) => {
          setMessages(r.messages);
          setLiveByAgent({});
        })
        .catch(() => {});
    }
  }

  const resolvePerm = async (
    pid: string,
    decision: PermissionDecision,
  ) => {
    try {
      await sendPermission(pid, decision);
      setLiveByAgent((s) => {
        const next: typeof s = {};
        for (const [agent, events] of Object.entries(s)) {
          if (!events) continue;
          next[agent as GroupAgentId] = events.map((e) =>
            e.type === "permission" && e.permissionId === pid
              ? { ...e, resolved: decision }
              : e,
          );
        }
        return next;
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.event.type === "permission" && m.event.permissionId === pid
            ? { ...m, event: { ...m.event, resolved: decision } }
            : m,
        ),
      );
    } catch (e) {
      console.error("permission resolve failed:", e);
    }
  };

  async function attachToLive() {
    const ac = new AbortController();
    turnAbortRef.current = ac;
    try {
      for await (const ev of attachGroupStream(gid, ac.signal)) {
        applyEvent(ev);
      }
    } catch {
      /* swallow */
    }
  }

  const handleSend = async (
    text: string,
    recipients: ("claude" | "codex" | "all")[],
  ) => {
    setError(null);
    const ac = new AbortController();
    turnAbortRef.current = ac;
    const sentQuote = quote;
    // Clear locally before fetching so the chip disappears immediately.
    setQuote(null);
    setComposerValue("");
    try {
      for await (const ev of streamGroupTurn(
        gid,
        {
          text,
          recipients,
          quote: sentQuote ?? undefined,
        },
        ac.signal,
      )) {
        applyEvent(ev);
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleQuote = (agent: GroupAgentId, text: string) => {
    setQuote({ agent, text });
    // No auto @mention; user picks recipient explicitly.
  };

  const handleStop = () => {
    stopGroupTurn(gid).catch(() => {});
  };

  const toggleStep = (id: string) =>
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const blocks = useMemo<Block[]>(
    () => buildBlocks(messages, liveByAgent, activeAgent),
    [messages, liveByAgent, activeAgent],
  );

  if (error && !config) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6">
        <div className="text-red text-[13px] mb-3 font-mono">
          load failed: {error}
        </div>
        <button
          onClick={onBack}
          className="h-8 px-3 rounded-md text-[12px] text-muted hover:text-fg hover:bg-fg/5 transition-colors"
        >
          ← 返回
        </button>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="flex items-center gap-2 text-subtle text-[12.5px] py-10 font-mono px-6">
        <span className="w-1.5 h-1.5 rounded-full bg-blue pulse-dot" />
        加载会话中…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-3 h-14 px-5 border-b border-line shrink-0">
        <button
          onClick={onBack}
          title="回到主页"
          className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-fg/5 transition-colors"
        >
          <div
            className={`w-2 h-2 rounded-full bg-blue ${running ? "pulse-dot" : ""}`}
            aria-hidden
          />
          <span className="font-semibold tracking-tight text-fg text-[15px] ml-0.5">
            {config.title}
          </span>
        </button>
        <span className="text-subtle">·</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">
          group
        </span>
        <span className="text-subtle">·</span>
        <span className="font-mono text-[12px] text-subtle truncate min-w-0">
          {tildify(config.cwd, home)}
        </span>
        {running && (
          <span className="ml-auto inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-amber/30 bg-amber/[0.06]">
            <span className="w-1.5 h-1.5 rounded-full bg-amber pulse-dot" />
            <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-amber">
              生成中
            </span>
          </span>
        )}
      </header>
      <ParticipantsBar
        config={config}
        activeAgent={activeAgent}
        onEdit={() => setEditing(true)}
        onTuneAgent={async (agentId, next) => {
          const cur = config!;
          const participants = cur.participants.map((p) =>
            p.id === agentId ? next : p,
          ) as GroupParticipant[];
          await updateGroupConfig(cur.id, { participants });
          // Reflect immediately so the pill updates without a full refetch.
          setConfig({ ...cur, participants, updatedAt: Date.now() });
        }}
      />
      <main ref={scrollRef} className="flex-1 relative overflow-hidden">
        <div className="h-full overflow-y-auto">
          <div className="max-w-[820px] mx-auto px-6 pb-4">
            {blocks.length === 0 && !running ? (
              <EmptyState />
            ) : (
              <div className="flex flex-col gap-5 py-8">
                {blocks.map((b, i) =>
                  b.kind === "user" ? (
                    <UserBlock
                      key={`u-${b.entry.event.id}-${i}`}
                      entry={b.entry}
                    />
                  ) : (
                    <AgentBlock
                      key={`a-${b.agent}-${i}`}
                      agent={b.agent}
                      events={b.events}
                      pipelineStep={b.pipelineStep}
                      isLive={b.isLive}
                      expandedSteps={expandedSteps}
                      onToggleStep={toggleStep}
                      onAnswerPermission={resolvePerm}
                      onQuote={handleQuote}
                      modelHint={modelOf(config, b.agent)}
                    />
                  ),
                )}
              </div>
            )}
            {error && (
              <div className="mt-4 amber-card rounded-lg px-3 py-2 text-[13px] text-fg font-mono">
                {error}
              </div>
            )}
          </div>
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-canvas to-transparent"
        />
      </main>
      <div className="shrink-0">
        <div className="max-w-[820px] mx-auto w-full">
          <GroupComposer
            running={running}
            value={composerValue}
            onChange={setComposerValue}
            quote={quote}
            onClearQuote={() => setQuote(null)}
            onSend={handleSend}
            onStop={handleStop}
            rightSlot={
              <TasksButton
                scope={tasksScope}
                onOpen={() => setTasksOpen(true)}
                refreshKey={tasksRefreshKey}
              />
            }
          />
        </div>
      </div>
      {editing && config && (
        <GroupConfigDialog
          mode={{
            kind: "edit",
            initial: config,
            onSaved: () => {
              setEditing(false);
              fetchGroup(gid)
                .then((r) => setConfig(r.config))
                .catch(() => {});
            },
          }}
          onClose={() => setEditing(false)}
        />
      )}
      {tasksOpen && (
        <TasksModal
          scope={tasksScope}
          onClose={() => {
            setTasksOpen(false);
            setTasksRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function modelOf(config: GroupConfig, agent: GroupAgentId): string | undefined {
  return config.participants.find((p) => p.id === agent)?.model;
}

function buildBlocks(
  messages: GroupTurnEntry[],
  liveByAgent: Partial<Record<GroupAgentId, ChatEvent[]>>,
  activeAgent: GroupAgentId | null,
): Block[] {
  const out: Block[] = [];
  for (const m of messages) {
    if (m.agent === "user") {
      out.push({ kind: "user", entry: m });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === "agent" && last.agent === m.agent) {
      last.events.push(m.event);
    } else {
      out.push({
        kind: "agent",
        agent: m.agent,
        events: [m.event],
        isLive: false,
        pipelineStep: m.meta?.pipelineStep,
      });
    }
  }
  if (activeAgent && liveByAgent[activeAgent]?.length) {
    out.push({
      kind: "agent",
      agent: activeAgent,
      events: liveByAgent[activeAgent]!,
      isLive: true,
    });
  }
  return out;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
        empty group
      </div>
      <div className="text-[13px] text-muted">
        输入 <code className="font-mono text-fg">@all</code> /{" "}
        <code className="font-mono text-fg">@claude</code> /{" "}
        <code className="font-mono text-fg">@codex</code> 开始对话
      </div>
      <div className="font-mono text-[11px] text-subtle/70 mt-2">
        无 @ 前缀 → @all 流水线
      </div>
    </div>
  );
}

function UserBlock({ entry }: { entry: GroupTurnEntry }) {
  if (entry.event.type !== "user") return null;
  const recipients = entry.meta?.recipients;
  const quote = entry.meta?.quote;
  return (
    <div
      className="flex justify-end msg-enter pt-3"
      style={{ animationDelay: "0ms" }}
    >
      <div className="user-bubble max-w-[78%] bg-blue text-white px-3.5 py-2.5 rounded-2xl text-[14.5px] leading-[1.6] flex flex-col gap-1.5">
        {quote && quote.text && (
          <div
            className="bg-white/[0.08] rounded-md pl-2.5 pr-2.5 py-1.5"
            style={{
              borderLeft: `2px solid ${
                AGENT_ACCENT[quote.agent as GroupAgentId]
              }`,
            }}
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/75 mb-0.5">
              引用 {quote.agent}
            </div>
            <div className="whitespace-pre-wrap line-clamp-3 leading-[1.5] text-[12.5px] text-white/90">
              {quote.text}
            </div>
          </div>
        )}
        {recipients && recipients.length === 1 && (
          <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-white/70">
            → @{recipients[0]}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{entry.event.text}</div>
      </div>
    </div>
  );
}

function AgentBlock({
  agent,
  events,
  isLive,
  expandedSteps,
  onToggleStep,
  onAnswerPermission,
  onQuote,
  modelHint,
}: {
  agent: GroupAgentId;
  events: ChatEvent[];
  pipelineStep?: number;
  isLive: boolean;
  expandedSteps: Set<string>;
  onToggleStep: (id: string) => void;
  onAnswerPermission: (id: string, decision: PermissionDecision) => void;
  onQuote?: (agent: GroupAgentId, text: string) => void;
  modelHint?: string;
}) {
  const accent = AGENT_ACCENT[agent];
  // Quote target: the last assistant text in the block. If there's no
  // assistant text yet (only thinking / steps), the button stays hidden.
  const quotableText = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "assistant" && e.text?.trim()) return e.text.trim();
    }
    return "";
  })();

  return (
    <div className="msg-enter group/block">
      {/* byline: dot + agent + model + optional streaming pulse.
          The hover-revealed action pill is INLINE here (right after
          the model name) so it sits close to the message text instead
          of floating at the container edge. */}
      <div className="flex items-center gap-2 mb-1">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: accent,
            outline: `3px solid ${accent}22`,
            outlineOffset: 0,
            boxShadow: isLive ? `0 0 14px ${accent}66` : undefined,
          }}
        />
        <span
          className="font-mono text-[10.5px] uppercase tracking-[0.12em]"
          style={{ color: accent }}
        >
          {agent}
        </span>
        {modelHint && (
          <span className="font-mono text-[10.5px] text-subtle/70 truncate">
            {modelHint}
          </span>
        )}
        {isLive && (
          <>
            <span className="text-subtle/40">·</span>
            <span
              className="font-mono text-[10.5px] inline-flex items-center gap-1"
              style={{ color: accent }}
            >
              <span
                className="w-1 h-1 rounded-full animate-pulse"
                style={{ background: accent }}
              />
              streaming
            </span>
          </>
        )}
        {/* hover-revealed action pill — WeChat style. Inline so it
            stays near the byline content (and the message text below)
            instead of floating at the container's right edge. */}
        {!isLive && quotableText && onQuote && (
          <div className="ml-2 inline-flex items-center bg-surface border border-line-strong rounded-md shadow-[0_2px_8px_-2px_rgba(0,0,0,0.18)] p-0.5 opacity-0 group-hover/block:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => onQuote(agent, quotableText)}
              title={`引用 ${agent} 的回复`}
              className="h-5 w-5 flex items-center justify-center rounded text-muted hover:text-fg hover:bg-fg/5 transition-colors"
            >
              <ReplyIcon />
            </button>
          </div>
        )}
      </div>

      <MessageList
        events={events}
        expandedSteps={expandedSteps}
        onToggleStep={onToggleStep}
        onAnswerPermission={onAnswerPermission}
        compact
      />
    </div>
  );
}

const ReplyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
    <path
      d="M5.5 3L2 6.5L5.5 10"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M2 6.5H8.5C10.4 6.5 12 8.1 12 10V11.5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
