import type { ChatEvent } from "../lib/types";
import UserBubble from "./UserBubble";
import AssistantText from "./AssistantText";
import StepTimeline from "./StepTimeline";
import PermissionCard from "./PermissionCard";
import SummaryCard from "./SummaryCard";

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
}

export default function MessageList({
  events,
  expandedSteps,
  onToggleStep,
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
            return <UserBubble key={ev.id} text={ev.text} delay={0} />;
          case "assistant":
            return <AssistantText key={ev.id} text={ev.text} delay={0} />;
          case "permission":
            return (
              <PermissionCard
                key={ev.id}
                question={ev.question}
                options={ev.options}
                delay={0}
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
    </div>
  );
}
