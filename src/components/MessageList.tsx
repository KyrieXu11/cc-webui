import type { ChatEvent, ImageAttachment, PermissionDecision } from "../lib/types";
import UserBubble from "./UserBubble";
import AssistantText from "./AssistantText";
import StepTimeline from "./StepTimeline";
import PermissionCard from "./PermissionCard";
import SummaryCard from "./SummaryCard";
import ThinkingBlock from "./ThinkingBlock";
import PendingHint from "./PendingHint";
import RetryHint from "./RetryHint";

export type RetryInfo = {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
};

type StepEvent = Extract<ChatEvent, { type: "step" }>;

type Block =
  | { kind: "step-group"; id: string; steps: StepEvent[] }
  | {
      kind: "single";
      id: string;
      event: Exclude<ChatEvent, { type: "step" }>;
    };

interface Props {
  events: ChatEvent[];
  expandedSteps: Set<string>;
  onToggleStep: (id: string) => void;
  onAnswerPermission: (
    permissionId: string,
    decision: PermissionDecision,
    message?: string
  ) => void;
  isPending?: boolean;
  retryInfo?: RetryInfo | null;
  onPreviewImage?: (img: ImageAttachment, label: string) => void;
}

export default function MessageList({
  events,
  expandedSteps,
  onToggleStep,
  onAnswerPermission,
  isPending,
  retryInfo,
  onPreviewImage,
}: Props) {
  const blocks: Block[] = [];
  for (const ev of events) {
    if (ev.type === "step") {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "step-group") last.steps.push(ev);
      else blocks.push({ kind: "step-group", id: `g-${ev.id}`, steps: [ev] });
    } else {
      blocks.push({ kind: "single", id: ev.id, event: ev });
    }
  }

  return (
    <div className="flex flex-col gap-5 py-8">
      {blocks.map((b) => {
        if (b.kind === "step-group") {
          return (
            <StepTimeline
              key={b.id}
              steps={b.steps}
              delay={0}
              expandedIds={expandedSteps}
              onToggle={onToggleStep}
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
            if (!ev.text.trim()) return null;
            return (
              <ThinkingBlock
                key={ev.id}
                text={ev.text}
                expanded={expandedSteps.has(ev.id)}
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
                delay={0}
                onAnswer={(decision, message) =>
                  onAnswerPermission(ev.permissionId, decision, message)
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
        isPending && blocks.length > 0 && <PendingHint />
      )}
    </div>
  );
}
