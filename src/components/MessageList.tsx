import type { ChatEvent, ImageAttachment, PermissionDecision } from "../lib/types";
import UserBubble from "./UserBubble";
import AssistantText from "./AssistantText";
import StepTimeline, { type TimelineRow } from "./StepTimeline";
import PermissionCard from "./PermissionCard";
import SummaryCard from "./SummaryCard";
import ThinkingBlock from "./ThinkingBlock";
import PendingHint from "./PendingHint";
import RetryHint from "./RetryHint";
import { liveThinkingIds, liveToolIds, showCodexActivity } from "../lib/turn-activity";

export type RetryInfo = {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
};

type Block =
  | { kind: "timeline"; id: string; rows: TimelineRow[] }
  | {
      kind: "single";
      id: string;
      event: Exclude<ChatEvent, { type: "step" }>;
    };

// An event that renders nothing must never reach `blocks`: as its own block it
// would split the surrounding timeline in two, leaving a blank gap and a broken
// connector line. Empty thinking is the common case — the Claude 5 family sends
// thinking with no plaintext at all (see ThinkingRow).
function rendersNothing(ev: ChatEvent, activeThinking?: Set<string>): boolean {
  if (ev.type === "assistant") return !ev.text.trim();
  if (ev.type === "thinking") return !ev.text.trim() && !(ev.tokens ?? 0) && !activeThinking?.has(ev.id);
  return false;
}

// Thinking with no prose is a status row inside the timeline; thinking WITH
// prose (sonnet-4-6 and older still return it) stays an expandable block.
function isThinkingStatus(
  ev: ChatEvent
): ev is Extract<ChatEvent, { type: "thinking" }> {
  return ev.type === "thinking" && !ev.text.trim();
}

interface Props {
  events: ChatEvent[];
  expandedSteps: Set<string>;
  onToggleStep: (id: string) => void;
  onAnswerPermission: (
    permissionId: string,
    decision: PermissionDecision,
    message?: string,
    answers?: Record<string, string>
  ) => void;
  isPending?: boolean;
  retryInfo?: RetryInfo | null;
  onPreviewImage?: (img: ImageAttachment, label: string) => void;
  // `compact` drops the outer py-8 / gap-5 spacing — useful when this list
  // is itself rendered inside a tighter container (e.g. a per-agent block
  // in a group chat) where the parent already provides spacing.
  compact?: boolean;
  // Effort level of the current turn, echoed on thinking status rows the way
  // the CLI does ("thinking with max effort").
  effort?: string;
  provider?: "claude" | "codex";
  isRunning?: boolean;
  turnStartedAt?: number;
}

export default function MessageList({
  events,
  expandedSteps,
  onToggleStep,
  onAnswerPermission,
  isPending,
  retryInfo,
  onPreviewImage,
  compact,
  effort,
  provider,
  isRunning,
  turnStartedAt,
}: Props) {
  const codex = provider === "codex";
  const activeThinking = codex ? liveThinkingIds(events, !!isRunning && !retryInfo) : undefined;
  const blocks: Block[] = [];
  // Step ids that still have an unresolved permission card: those steps are
  // "awaiting approval", not actually executing yet.
  const awaitingPermission = new Set<string>();
  for (const ev of events) {
    if (rendersNothing(ev, activeThinking)) continue;
    if (ev.type === "step" || isThinkingStatus(ev)) {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "timeline") last.rows.push(ev);
      else blocks.push({ kind: "timeline", id: `g-${ev.id}`, rows: [ev] });
    } else {
      if (
        ev.type === "permission" &&
        ev.resolved === undefined &&
        ev.toolUseId
      ) {
        awaitingPermission.add(`s-${ev.toolUseId}`);
      }
      blocks.push({ kind: "single", id: ev.id, event: ev });
    }
  }

  const activeTools = codex ? liveToolIds(events, !!isRunning) : undefined;
  if (codex && !retryInfo && showCodexActivity(events, !!isRunning)) {
    const row: TimelineRow = { id: "live-codex-activity", type: "activity", turnStartedAt };
    const last = blocks[blocks.length - 1];
    if (last?.kind === "timeline") last.rows.push(row);
    else blocks.push({ kind: "timeline", id: row.id, rows: [row] });
  }

  return (
    <div className={`flex flex-col ${compact ? "gap-3" : "gap-5 py-8"}`}>
      {blocks.map((b) => {
        if (b.kind === "timeline") {
          return (
            <StepTimeline
              key={b.id}
              rows={b.rows}
              delay={0}
              expandedIds={expandedSteps}
              onToggle={onToggleStep}
              awaitingPermission={awaitingPermission}
              effort={effort}
              liveToolIds={activeTools}
              liveThinkingIds={activeThinking}
            />
          );
        }
        const ev = b.event;
        switch (ev.type) {
          case "user":
            return (
              <UserBubble
                key={ev.id}
                text={ev.text}
                images={ev.images}
                delay={0}
                onPreviewImage={onPreviewImage}
              />
            );
          case "assistant":
            return <AssistantText key={ev.id} text={ev.text} delay={0} />;
          case "thinking":
            return (
              <ThinkingBlock
                key={ev.id}
                text={ev.text}
                expanded={expandedSteps.has(ev.id)}
                live={activeThinking === undefined ? undefined : activeThinking.has(ev.id)}
                onToggle={() => onToggleStep(ev.id)}
              />
            );
          case "permission":
            return (
              <PermissionCard
                key={ev.id}
                tool={ev.tool}
                input={ev.input}
                resolved={ev.resolved}
                stale={ev.stale}
                title={ev.title}
                description={ev.description}
                hasSessionPermissionSuggestions={
                  ev.hasSessionPermissionSuggestions
                }
                delay={0}
                onAnswer={(decision, message, answers) =>
                  onAnswerPermission(ev.permissionId, decision, message, answers)
                }
              />
            );
          case "summary":
            return (
              <SummaryCard
                key={ev.id}
                title={ev.title}
                body={ev.body}
                delay={0}
              />
            );
        }
      })}
      {retryInfo ? (
        <RetryHint
          attempt={retryInfo.attempt}
          maxRetries={retryInfo.maxRetries}
          retryDelayMs={retryInfo.retryDelayMs}
          errorStatus={retryInfo.errorStatus}
        />
      ) : (
        !codex && isPending && blocks.length > 0 && <PendingHint />
      )}
    </div>
  );
}
