import { useEffect, useRef, useState } from "react";
import { pickThinkingWord } from "../lib/thinking-words";
import { activityLabel, formatActivityElapsed } from "../lib/turn-activity";

// Encrypted-thinking status row — the equivalent of Claude Code's
//   ✻ Tinkering… (49s · ↓ 2.0k tokens · thinking with max effort)
//
// Why this exists at all: the Claude 5 family returns thinking with NO
// plaintext (`thinking_delta` carries `thinking: ""` + `estimated_tokens`), so
// `ThinkingBlock` — which is a renderer for the prose, with the animated header
// riding along on it — never mounts. The token counter is the only progress
// signal the stream gives us, so it gets its own row.
//
// Lives inside StepTimeline rather than beside it: an event that renders
// nothing (or renders as its own block) would split the step group and break
// the connector line, which is exactly the artifact this replaces.

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

interface Props {
  tokens: number;
  // Explicit liveness is separate from the meaning of the row. Codex can
  // report a pending reasoning item without public text or token deltas.
  live?: boolean;
  kind?: "thinking" | "turn";
  turnStartedAt?: number;
  // Shown as the trailing "· max effort", mirroring the CLI's
  // "thinking with max effort". Omitted when the caller has no effort context.
  effort?: string;
}

export default function ThinkingRow({ tokens, effort, live, kind = "thinking", turnStartedAt }: Props) {
  const totalTurn = kind === "turn";
  const [label, setLabel] = useState(() => pickThinkingWord());
  // Deliberately starts inactive: a row replayed from history has a fixed token
  // count and must not spin. Only an actual token bump means "thinking now".
  const initialTokens = useRef(tokens);
  const [tokenActive, setActive] = useState(false);
  const active = live ?? tokenActive;
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startedAt = useRef<number | null>(totalTurn && live ? turnStartedAt ?? Date.now() : null);

  useEffect(() => {
    if (live !== undefined || tokens === initialTokens.current) return;
    if (startedAt.current === null) startedAt.current = Date.now();
    setActive(true);
    // Thinking is bursty; a few quiet seconds means the block is done. The
    // stream gives no content_block_stop we can rely on here.
    const t = setTimeout(() => setActive(false), 4000);
    return () => clearTimeout(t);
  }, [tokens, live]);

  useEffect(() => {
    if (!active) return;
    if (totalTurn && live && turnStartedAt !== undefined) startedAt.current = turnStartedAt;
    const tick = () => {
      if (startedAt.current !== null) setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)));
    };
    tick();
    const verbTimer = totalTurn ? undefined : setInterval(() => {
      setLabel((cur) => pickThinkingWord(cur));
    }, 1800);
    const tickTimer = setInterval(tick, 1000);
    return () => {
      clearInterval(verbTimer);
      clearInterval(tickTimer);
    };
  }, [active, live, totalTurn, turnStartedAt]);

  const meta = [
    // Turn activity includes tools. Explicit Codex reasoning has no reliable
    // start/end timestamps, so it keeps the animation but invents no duration.
    elapsed !== null ? formatActivityElapsed(elapsed, totalTurn) : null,
    tokens > 0 ? `↓ ${formatTokens(tokens)} tokens` : null,
    active && effort ? `${effort} effort` : null,
  ].filter(Boolean);

  return (
    <div className="relative flex items-center py-[6px] gap-3 w-full text-left"
      aria-label={totalTurn ? "Codex 处理中" : live ? "Codex 思考中" : undefined}
      title={totalTurn ? "当前回合仍在处理；耗时包含模型等待和工具执行，不代表连续思考时长" : live ? "收到 Codex reasoning 进行中事件；未提供可靠的独立思考时长" : undefined}>
      <div className="relative z-10 shrink-0 bg-surface">
        <Sparkle active={active} />
      </div>
      <div className="flex items-baseline gap-2 text-[13px] min-w-0 flex-1">
        <span className="font-mono text-orange">
          {activityLabel(active, label, totalTurn)}
        </span>
        {meta.length > 0 && (
          <span className="font-mono text-[11.5px] text-subtle truncate tabular-nums">
            ({meta.join(" · ")})
          </span>
        )}
      </div>
    </div>
  );
}

// Same ✻ mark as ThinkingBlock — one thinking glyph across the whole UI.
const Sparkle = ({ active }: { active: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden
    className={`text-orange ${active ? "sparkle-spin" : ""}`}
  >
    <path
      d="M7 1 L7 13 M1 7 L13 7 M2.5 2.5 L11.5 11.5 M2.5 11.5 L11.5 2.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);
