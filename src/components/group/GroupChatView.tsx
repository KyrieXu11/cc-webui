import { useEffect, useRef, useState } from "react";
import AssistantText from "../AssistantText";
import ParticipantsBar from "./ParticipantsBar";
import GroupComposer from "./GroupComposer";
import {
  attachGroupStream,
  fetchGroup,
  stopGroupTurn,
  streamGroupTurn,
} from "../../lib/groups";
import type {
  GroupAgentId,
  GroupConfig,
  GroupSseEvent,
  GroupTurnEntry,
} from "../../lib/types";

const AGENT_STYLE: Record<
  string,
  { label: string; ring: string; chip: string }
> = {
  claude: {
    label: "Claude",
    ring: "border-l-2 border-l-purple-500",
    chip: "text-purple-400",
  },
  codex: {
    label: "Codex",
    ring: "border-l-2 border-l-emerald-500",
    chip: "text-emerald-400",
  },
};

type LiveBuf = { text: string; thinking: string };

type Props = {
  gid: string;
  onBack: () => void;
};

export default function GroupChatView({ gid, onBack }: Props) {
  const [config, setConfig] = useState<GroupConfig | null>(null);
  const [messages, setMessages] = useState<GroupTurnEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [activeAgent, setActiveAgent] = useState<GroupAgentId | null>(null);
  const [liveByAgent, setLiveByAgent] = useState<Record<string, LiveBuf>>({});
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

  // Auto-scroll to bottom on new messages / live updates
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
        id: `optimistic-${ev.turnId}`,
        ts: Date.now(),
        type: "user",
        agent: "user",
        text: ev.userText,
        recipients: ev.recipients,
        meta: { turnId: ev.turnId },
      };
      setMessages((prev) =>
        prev.some((m) => m.id === optimistic.id) ? prev : [...prev, optimistic],
      );
    }
    if (ev.type === "agent_begin") {
      setActiveAgent(ev.agent);
      setLiveByAgent((s) => ({ ...s, [ev.agent]: { text: "", thinking: "" } }));
    }
    if (ev.type === "agent_event") {
      const p: any = ev.payload;
      // Claude: stream_event content_block_delta — text or thinking deltas
      if (p?.type === "stream_event" && p.event?.type === "content_block_delta") {
        const d = p.event.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          setLiveByAgent((s) => {
            const cur = s[ev.agent] ?? { text: "", thinking: "" };
            return { ...s, [ev.agent]: { ...cur, text: cur.text + d.text } };
          });
        }
        if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
          setLiveByAgent((s) => {
            const cur = s[ev.agent] ?? { text: "", thinking: "" };
            return {
              ...s,
              [ev.agent]: { ...cur, thinking: cur.thinking + d.thinking },
            };
          });
        }
      }
      // Codex: item.completed agent_message → full text replaces buffer
      if (
        p?.type === "item.completed" &&
        p.item?.type === "agent_message" &&
        typeof p.item.text === "string"
      ) {
        setLiveByAgent((s) => {
          const cur = s[ev.agent] ?? { text: "", thinking: "" };
          return { ...s, [ev.agent]: { ...cur, text: p.item.text } };
        });
      }
      if (
        p?.type === "item.completed" &&
        p.item?.type === "reasoning" &&
        typeof p.item.text === "string"
      ) {
        setLiveByAgent((s) => {
          const cur = s[ev.agent] ?? { text: "", thinking: "" };
          const sep = cur.thinking ? "\n\n" : "";
          return {
            ...s,
            [ev.agent]: { ...cur, thinking: cur.thinking + sep + p.item.text },
          };
        });
      }
    }
    if (ev.type === "agent_end") {
      // Refetch to pull in canonicalized assistant entry, drop the live buf.
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

  if (error && !config) {
    return (
      <div className="p-6 text-red-400">
        <div className="mb-3">加载群聊失败：{error}</div>
        <button onClick={onBack} className="px-3 py-1 bg-surface border border-soft rounded">
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
        <div className="max-w-[820px] mx-auto px-6 py-4 space-y-3">
          {messages.length === 0 && !running && (
            <div className="text-subtle text-[13px] py-6">
              群聊为空，输入 @all / @claude / @codex 开始对话。
            </div>
          )}
          {messages.map((m) => (
            <PersistedBubble key={m.id} entry={m} />
          ))}
          {Object.entries(liveByAgent).map(([agent, buf]) => (
            <LiveBubble key={`live-${agent}`} agent={agent} buf={buf} />
          ))}
          {error && (
            <div className="text-red-400 text-[13px] border border-red-500/30 bg-red-500/5 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>
      </main>
      <div className="max-w-[820px] mx-auto w-full">
        <GroupComposer running={running} onSend={handleSend} onStop={handleStop} />
      </div>
    </div>
  );
}

function PersistedBubble({ entry }: { entry: GroupTurnEntry }) {
  if (entry.type === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-blue/15 border border-blue/30 px-3 py-2 rounded-lg max-w-[85%] whitespace-pre-wrap text-[14.5px]">
          {entry.recipients && entry.recipients[0] && (
            <div className="text-[11px] text-blue/80 font-mono mb-1">
              @{entry.recipients[0]}
            </div>
          )}
          {entry.text}
        </div>
      </div>
    );
  }
  if (entry.type === "thinking") {
    const style = AGENT_STYLE[entry.agent as string];
    return (
      <details className={`text-[12px] text-subtle pl-3 ${style?.ring ?? ""}`}>
        <summary className="cursor-pointer">
          <span className={style?.chip}>{style?.label ?? entry.agent}</span> · 思考过程
        </summary>
        <div className="mt-1 whitespace-pre-wrap font-mono">{entry.text}</div>
      </details>
    );
  }
  if (entry.type === "error") {
    const style = AGENT_STYLE[entry.agent as string];
    return (
      <div className={`pl-3 ${style?.ring ?? ""} border-l-red-500`}>
        <div className={`text-[11px] ${style?.chip ?? ""}`}>
          {style?.label ?? entry.agent} · 错误
        </div>
        <div className="text-red-400 text-[13px]">{entry.text}</div>
      </div>
    );
  }
  if (entry.type === "assistant" && entry.text) {
    const style = AGENT_STYLE[entry.agent as string];
    return (
      <div className={`pl-3 ${style?.ring ?? ""}`}>
        <div className={`text-[11px] mb-1 ${style?.chip ?? ""}`}>
          {style?.label ?? entry.agent}
          {entry.meta?.pipelineStep != null && (
            <span className="ml-2 text-subtle">
              step {entry.meta.pipelineStep + 1}
            </span>
          )}
        </div>
        <AssistantText text={entry.text} />
      </div>
    );
  }
  return null;
}

function LiveBubble({ agent, buf }: { agent: string; buf: LiveBuf }) {
  const style = AGENT_STYLE[agent];
  if (!buf.text && !buf.thinking) {
    return (
      <div className={`pl-3 ${style?.ring ?? ""} text-[12px] text-subtle italic`}>
        <span className={style?.chip}>{style?.label ?? agent}</span> 正在准备…
      </div>
    );
  }
  return (
    <div className={`pl-3 ${style?.ring ?? ""}`}>
      <div className={`text-[11px] mb-1 ${style?.chip ?? ""}`}>
        {style?.label ?? agent} <span className="text-subtle">· 生成中…</span>
      </div>
      {buf.thinking && (
        <details className="text-[12px] text-subtle mb-1">
          <summary className="cursor-pointer">思考中…</summary>
          <div className="mt-1 whitespace-pre-wrap font-mono">{buf.thinking}</div>
        </details>
      )}
      {buf.text && <AssistantText text={buf.text} />}
    </div>
  );
}
