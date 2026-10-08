import type { ChatEvent } from "../lib/types";
import EditDiff from "./EditDiff";
import ApplyPatchDiff, { PatchStats } from "./ApplyPatchDiff";
import ThinkingRow from "./ThinkingRow";
import CodexActivityRow from "./CodexActivityRow";
import { useEffect, useState } from "react";

type StepEvent = Extract<ChatEvent, { type: "step" }>;
type ThinkingEvent = Extract<ChatEvent, { type: "thinking" }>;

// The timeline interleaves tool calls with encrypted-thinking status rows —
// exactly the order the model produced them (thinking, then the tool batch it
// decided on). Keeping thinking INSIDE the group is what keeps the connector
// line continuous; when these rows were separate blocks, every one of them cut
// the line in two and left a blank gap.
export type TimelineRow = StepEvent | ThinkingEvent | { id: string; type: "activity" };

function ToolElapsed({ reported = 0 }: { reported?: number }) {
  const [elapsed, setElapsed] = useState(reported);
  useEffect(() => {
    const start = Date.now() - reported * 1000;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick(); const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [reported]);
  return <span className="font-mono text-subtle shrink-0 tabular-nums" aria-label="工具等待时长">
    {elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`}
  </span>;
}

const CheckIcon = ({
  status,
  waiting,
}: {
  status: StepEvent["status"];
  waiting?: boolean;
}) => {
  if (status === "error") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
        <circle cx="7" cy="7" r="7" fill="var(--color-red)" />
        <path
          d="M4.5 4.5L9.5 9.5M9.5 4.5L4.5 9.5"
          stroke="var(--color-on-status)"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (status === "pending") {
    // Waiting for user approval: static dashed circle (not executing yet).
    if (waiting) {
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
    // Approved and actually executing: spinner.
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden
        className="animate-spin"
      >
        <circle
          cx="7"
          cy="7"
          r="6"
          stroke="var(--color-line-strong)"
          strokeWidth="1.5"
        />
        <path
          d="M13 7a6 6 0 0 0-6-6"
          stroke="var(--color-blue)"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="7" fill="var(--color-green)" />
      <path
        d="M4 7.1L6.2 9.1L10 5.2"
        stroke="var(--color-on-status)"
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
  status,
}: {
  tool: string;
  input?: any;
  output?: string;
  status: StepEvent["status"];
}) {
  if (tool === "ApplyPatch" && Array.isArray(input?.changes)) {
    return <ApplyPatchDiff changes={input.changes} failed={status === "error"} />;
  }
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
          <pre className="bg-surface-2 rounded-panel p-2.5 overflow-x-auto font-mono text-[11.5px] leading-[1.6] text-fg">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {hasOutput && (
        <div>
          <div className="text-[10px] font-mono text-subtle uppercase tracking-[0.08em] mb-1">
            output
          </div>
          <pre className="bg-surface-2 rounded-panel p-2.5 overflow-auto max-h-[360px] font-mono text-[11.5px] leading-[1.6] text-muted whitespace-pre-wrap">
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}

interface Props {
  rows: TimelineRow[];
  delay?: number;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  // Step ids (`s-<toolUseId>`) that still have an unanswered permission card.
  // These render a static dashed circle; otherwise pending renders a spinner.
  awaitingPermission?: Set<string>;
  // Effort level of the turn, shown on thinking rows ("· max effort").
  effort?: string;
  liveToolIds?: Set<string>;
  liveThinkingIds?: Set<string>;
}

export default function StepTimeline({
  rows,
  delay = 0,
  expandedIds,
  onToggle,
  awaitingPermission,
  effort,
  liveToolIds,
  liveThinkingIds,
}: Props) {
  return (
    <div
      className="relative pl-1 msg-enter"
      style={{ animationDelay: `${delay}ms` }}
    >
      {rows.length > 1 && (
        <div className="absolute left-[11px] top-[13px] bottom-[13px] w-px bg-fg/10" />
      )}
      <div className="flex flex-col">
        {rows.map((row) => {
          if (row.type === "activity") return <CodexActivityRow key={row.id} />;
          if (row.type === "thinking") {
            if (liveThinkingIds !== undefined) {
              return <CodexActivityRow key={row.id} phase="reasoning" active={liveThinkingIds.has(row.id)} effort={effort} />;
            }
            return (
              <ThinkingRow
                key={row.id}
                tokens={row.tokens ?? 0}
                effort={effort}
              />
            );
          }
          const s = row;
          const open = expandedIds.has(s.id);
          return (
            <div key={s.id}>
              <button
                onClick={() => onToggle(s.id)}
                className="relative flex items-center py-[6px] gap-3 w-full text-left group hover:bg-fg/[0.02] rounded-sm transition-colors"
              >
                <div className="relative z-10 shrink-0 bg-surface">
                  <CheckIcon
                    status={s.status}
                    waiting={awaitingPermission?.has(s.id) || (liveToolIds !== undefined && !liveToolIds.has(s.id))}
                  />
                </div>
                <div className="flex items-baseline gap-2 text-[13px] min-w-0 flex-1">
                  <span className="font-mono text-fg">{s.tool}</span>
                  {s.arg && (
                    <span className="font-mono text-subtle truncate">
                      {s.arg}
                    </span>
                  )}
                  {s.tool === "ApplyPatch" && <PatchStats changes={s.input?.changes} />}
                  {/* 慢工具的已等待时长。本地工具最长能等 5.5 分钟（扫码登录
                      要等人拿手机），没有这个数字的话 UI 停在「进行中」和
                      「卡死了」看起来一模一样。 */}
                  {s.status === "pending" && s.elapsedSeconds !== undefined && (
                    <span className="font-mono text-subtle shrink-0 tabular-nums">
                      {s.elapsedSeconds >= 60
                        ? `${Math.floor(s.elapsedSeconds / 60)}m${s.elapsedSeconds % 60}s`
                        : `${s.elapsedSeconds}s`}
                    </span>
                  )}
                  {s.status === "pending" && s.elapsedSeconds === undefined && liveToolIds?.has(s.id) && <ToolElapsed />}
                </div>
                <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pr-1">
                  <Chevron open={open} />
                </div>
              </button>
              {open && (
                <StepDetails tool={s.tool} input={s.input} output={s.output} status={s.status} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
