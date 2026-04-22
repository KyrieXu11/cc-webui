import type { ChatEvent } from "../lib/types";
import EditDiff from "./EditDiff";

type StepEvent = Extract<ChatEvent, { type: "step" }>;

const CheckIcon = ({ status }: { status: StepEvent["status"] }) => {
  if (status === "error") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
        <circle cx="7" cy="7" r="7" fill="#E05252" />
        <path
          d="M4.5 4.5L9.5 9.5M9.5 4.5L4.5 9.5"
          stroke="#0A0D14"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (status === "pending") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
        <circle
          cx="7"
          cy="7"
          r="6"
          stroke="var(--color-subtle)"
          strokeWidth="1.3"
          strokeDasharray="3 2"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="7" fill="var(--color-green)" />
      <path
        d="M4 7.1L6.2 9.1L10 5.2"
        stroke="#0A0D14"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 9 9"
    fill="none"
    className={`text-subtle transition-transform ${open ? "rotate-90" : ""}`}
  >
    <path
      d="M3 2L6 4.5L3 7"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function StepDetails({
  tool,
  input,
  output,
}: {
  tool: string;
  input?: any;
  output?: string;
}) {
  const isDiffTool =
    tool === "Edit" || tool === "Write" || tool === "NotebookEdit";
  if (isDiffTool && input) {
    return <EditDiff tool={tool} input={input} />;
  }

  const hasInput = input && Object.keys(input).length > 0;
  const hasOutput = output && output.length > 0;
  if (!hasInput && !hasOutput) {
    return (
      <div className="ml-[27px] mt-1 mb-2 text-[11.5px] text-subtle font-mono">
        没有更多信息
      </div>
    );
  }
  return (
    <div className="ml-[27px] mt-1.5 mb-2 space-y-2">
      {hasInput && (
        <div>
          <div className="text-[10px] font-mono text-subtle uppercase tracking-[0.08em] mb-1">
            input
          </div>
          <pre className="bg-surface border border-line rounded-md p-2.5 overflow-x-auto font-mono text-[11.5px] leading-[1.6] text-fg">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {hasOutput && (
        <div>
          <div className="text-[10px] font-mono text-subtle uppercase tracking-[0.08em] mb-1">
            output
          </div>
          <pre className="bg-surface border border-line rounded-md p-2.5 overflow-auto max-h-[360px] font-mono text-[11.5px] leading-[1.6] text-muted whitespace-pre-wrap">
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}

interface Props {
  steps: StepEvent[];
  delay?: number;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
}

export default function StepTimeline({
  steps,
  delay = 0,
  expandedIds,
  onToggle,
}: Props) {
  return (
    <div
      className="relative pl-1 msg-enter"
      style={{ animationDelay: `${delay}ms` }}
    >
      {steps.length > 1 && (
        <div className="absolute left-[11px] top-[13px] bottom-[13px] w-px bg-fg/10" />
      )}
      <div className="flex flex-col">
        {steps.map((s) => {
          const open = expandedIds.has(s.id);
          return (
            <div key={s.id}>
              <button
                onClick={() => onToggle(s.id)}
                className="relative flex items-center py-[6px] gap-3 w-full text-left group hover:bg-fg/[0.02] rounded-sm transition-colors"
              >
                <div className="relative z-10 shrink-0 bg-canvas">
                  <CheckIcon status={s.status} />
                </div>
                <div className="flex items-baseline gap-2 text-[13px] min-w-0 flex-1">
                  <span className="font-mono text-fg">{s.tool}</span>
                  {s.arg && (
                    <span className="font-mono text-subtle truncate">
                      {s.arg}
                    </span>
                  )}
                </div>
                <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pr-1">
                  <Chevron open={open} />
                </div>
              </button>
              {open && (
                <StepDetails tool={s.tool} input={s.input} output={s.output} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
