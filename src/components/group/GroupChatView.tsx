import { useEffect, useMemo, useRef, useState } from "react";
import MessageList from "../MessageList";
import ParticipantsBar from "./ParticipantsBar";
import GroupComposer from "./GroupComposer";
import {
  attachGroupStream,
  fetchGroup,
  stopGroupTurn,
  streamGroupTurn,
} from "../../lib/groups";
import { sendPermission } from "../../lib/permission";
import { applySDKMessage } from "../../lib/processor";
import type {
  ChatEvent,
  GroupAgentId,
  GroupConfig,
  GroupSseEvent,
  GroupTurnEntry,
  PermissionDecision,
} from "../../lib/types";

const AGENT_STYLE: Record<
  string,
  { label: string; ring: string; chip: string }
> = {
  claude: {
    label: "Claude",
    ring: "border-l-2 border-l-purple-500 pl-3",
    chip: "text-purple-400",
  },
  codex: {
    label: "Codex",
    ring: "border-l-2 border-l-emerald-500 pl-3",
    chip: "text-emerald-400",
  },
};

type Block =
  | { kind: "user"; entry: GroupTurnEntry }
  | { kind: "agent"; agent: GroupAgentId; events: ChatEvent[]; isLive: boolean };

type Props = {
  gid: string;
  onBack: () => void;
};

export default function GroupChatView({ gid, onBack }: Props) {
  const [config, setConfig] = useState<GroupConfig | null>(null);
  const [messages, setMessages] = useState<GroupTurnEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [activeAgent, setActiveAgent] = useState<GroupAgentId | null>(null);
  const [liveByAgent, setLiveByAgent] = useState<
    Partial<Record<GroupAgentId, ChatEvent[]>>
  >({});
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
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

  // Auto-scroll to bottom
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

  function applyEvent(ev: GroupSseEvent) {
    if (ev.type === "turn_begin") {
      setRunning(true);
      setLiveByAgent({});
      setActiveAgent(null);
      // Optimistically mirror the user message until refetch confirms.
      const optimistic: GroupTurnEntry = {
        agent: "user",
        ts: Date.now(),
        event: {
          id: `optimistic-${ev.turnId}`,
          type: "user",
          text: ev.userText,
        },
        meta: { turnId: ev.turnId, recipients: ev.recipients },
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
        // Only update if changed to avoid useless re-renders.
        if (next === cur) return s;
        return { ...s, [ev.agent]: next };
      });
    }
    if (ev.type === "agent_end") {
      // Refetch to pull in canonicalized entries; clear the live buffer
      // so the persisted block takes over rendering.
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
      // Mark in-flight live event as resolved so the card flips its state.
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
      // Same for persisted (cards may already have been written).
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
    try {
      for await (const ev of streamGroupTurn(
        gid,
        { text, recipients },
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
      <div className="p-6 text-red-400">
        <div className="mb-3">加载群聊失败：{error}</div>
        <button
          onClick={onBack}
          className="px-3 py-1 bg-surface border border-soft rounded"
        >
          返回
        </button>
      </div>
    );
  }
  if (!config) {
    return <div className="p-6 text-subtle">加载中…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-soft">
        <button
          onClick={onBack}
          className="text-subtle hover:text-fg text-[13px]"
        >
          ←
        </button>
        <span className="font-semibold">{config.title}</span>
        <span className="text-subtle text-[12px] truncate">{config.cwd}</span>
        {running && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-amber-400 text-[12px]">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 pulse-dot" />
            生成中
          </span>
        )}
      </div>
      <ParticipantsBar config={config} activeAgent={activeAgent} />
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-[820px] mx-auto px-6 py-4">
          {blocks.length === 0 && !running && (
            <div className="text-subtle text-[13px] py-6">
              群聊为空，输入 @all / @claude / @codex 开始对话。
            </div>
          )}
          <div className="flex flex-col gap-4">
            {blocks.map((b, i) =>
              b.kind === "user" ? (
                <UserBubbleEntry key={`u-${b.entry.event.id}-${i}`} entry={b.entry} />
              ) : (
                <AgentBlock
                  key={`a-${b.agent}-${i}`}
                  agent={b.agent}
                  events={b.events}
                  expandedSteps={expandedSteps}
                  onToggleStep={toggleStep}
                  onAnswerPermission={resolvePerm}
                  isLive={b.isLive}
                />
              ),
            )}
          </div>
          {error && (
            <div className="mt-4 text-red-400 text-[13px] border border-red-500/30 bg-red-500/5 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>
      </main>
      <div className="max-w-[820px] mx-auto w-full">
        <GroupComposer
          running={running}
          onSend={handleSend}
          onStop={handleStop}
        />
      </div>
    </div>
  );
}

// Walk persisted messages chronologically, grouping consecutive same-agent
// entries into one block so MessageList can render them as a unit (steps
// share a timeline, etc.). Then append a live block for the active agent
// while a turn is mid-flight.
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
      });
    }
  }
  // Append live blocks AFTER persisted entries. If the active agent already
  // has a persisted block right before this point, we don't merge — the live
  // events already include everything from the start of the turn.
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

function UserBubbleEntry({ entry }: { entry: GroupTurnEntry }) {
  if (entry.event.type !== "user") return null;
  const text = entry.event.text;
  const recipients = entry.meta?.recipients;
  return (
    <div className="flex justify-end">
      <div className="bg-blue/15 border border-blue/30 px-3 py-2 rounded-lg max-w-[85%] whitespace-pre-wrap text-[14.5px]">
        {recipients && recipients[0] && (
          <div className="text-[11px] text-blue/80 font-mono mb-1">
            @{recipients[0]}
          </div>
        )}
        {text}
      </div>
    </div>
  );
}

function AgentBlock({
  agent,
  events,
  expandedSteps,
  onToggleStep,
  onAnswerPermission,
  isLive,
}: {
  agent: GroupAgentId;
  events: ChatEvent[];
  expandedSteps: Set<string>;
  onToggleStep: (id: string) => void;
  onAnswerPermission: (id: string, decision: PermissionDecision) => void;
  isLive: boolean;
}) {
  const style = AGENT_STYLE[agent];
  return (
    <div className={style?.ring ?? ""}>
      <div className={`text-[11px] mb-1 ${style?.chip ?? ""}`}>
        {style?.label ?? agent}
        {isLive && <span className="ml-2 text-subtle">· 生成中…</span>}
      </div>
      <MessageList
        events={events}
        expandedSteps={expandedSteps}
        onToggleStep={onToggleStep}
        onAnswerPermission={onAnswerPermission}
      />
    </div>
  );
}
