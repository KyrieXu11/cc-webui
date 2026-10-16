import type { ChatEvent } from "../lib/types";
import EditDiff from "./EditDiff";
import ApplyPatchDiff, { PatchStats } from "./ApplyPatchDiff";
import ThinkingRow from "./ThinkingRow";
import ThinkingBlock from "./ThinkingBlock";
import CodexActivityRow from "./CodexActivityRow";
import { summarizeToolTimeline, visibleTimelineRows, mountedTimelineRows, timelinePhase, type TimelineRow } from "../lib/tool-timeline";
import { useCallback, useEffect, useId, useState } from "react";

export type { TimelineRow } from "../lib/tool-timeline";

type StepEvent = Extract<ChatEvent, { type: "step" }>;

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
    aria-hidden
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
  executingIds?: Set<string>;
  thinkingCandidateId?: string;
  activePermissionIds?: Set<string>;
}

// The timeline interleaves tool calls with encrypted-thinking status rows —
// exactly the order the model produced them (thinking, then the tool batch it
// decided on). Keeping thinking INSIDE the group is what keeps the connector
// line continuous; when these rows were separate blocks, every one of them cut
// the line in two and left a blank gap.

export default function StepTimeline({
  rows,
  delay = 0,
  expandedIds,
  onToggle,
  awaitingPermission,
  effort,
  liveToolIds,
  liveThinkingIds,
  executingIds,
  thinkingCandidateId,
  activePermissionIds,
}: Props) {
  const panelId = useId();
  const [statusSlot, setStatusSlot] = useState<HTMLSpanElement | null>(null);
  const [statusMetaSlot, setStatusMetaSlot] = useState<HTMLSpanElement | null>(null);
  const [observedThinkingIds, setObservedThinkingIds] = useState(new Set<string>());
  const onThinkingActivity = useCallback((id: string, active: boolean) => {
    setObservedThinkingIds(prev => {
      if (prev.has(id) === active) return prev;
      const next = new Set(prev);
      if (active) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const summary = summarizeToolTimeline(rows, awaitingPermission);
  // A standalone Codex activity has no history to disclose, but still belongs
  // inside the same visual shell as recorded thinking/tools.
  const activityOnly = !summary.collapsible && rows.some(row => row.type === "activity");
  const framed = summary.collapsible || activityOnly;
  const groupKey = summary.key;
  const expanded = !summary.collapsible || groupKey === undefined || expandedIds.has(groupKey);
  const visibleRows = visibleTimelineRows(rows, expanded);
  const mountedRows = mountedTimelineRows(rows, expanded);
  const phase = timelinePhase(rows, { executingIds, awaitingPermission: activePermissionIds, liveThinkingIds, thinkingCandidateId, observedThinkingIds });
  const label = { tools: "工具调用", reasoning: "思考中", processing: "执行中", approval: "待审批", idle: "执行记录" }[phase.phase];
  const liveThoughtTitle = phase.phase === "reasoning" && !expanded;
  const runningTool = phase.phase === "tools" ? rows.find(row => row.type === "step" && executingIds?.has(row.id)) : undefined;
  return (
    <div
      className={`tool-timeline msg-enter ${framed ? "tool-timeline-frame" : ""}`}
      data-timeline-phase={phase.phase}
      data-activity-only={activityOnly || undefined}
      style={{ animationDelay: `${delay}ms` }}
    >
      {summary.collapsible && groupKey !== undefined && (
        <button
          type="button"
          data-tool-summary
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => onToggle(groupKey)}
          className="tool-timeline-toggle"
          data-timeline-phase={phase.phase}
          title={phase.phase === "processing" ? "模型仍在处理，CLI 未提供明确的当前阶段；不代表已确认正在思考" : "展开或收起思考和工具记录；审批卡独立显示，原思考计时不变"}
        >
          <span className="tool-timeline-chevron">
            {phase.phase === "tools" ? <svg className="tool-timeline-running" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
              <path d="M12.5 7A5.5 5.5 0 0 0 7 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg> : <Chevron open={expanded} />}
          </span>
          <span className="tool-timeline-heading" data-live-title={liveThoughtTitle}>
            {!liveThoughtTitle && <span className="tool-timeline-label">{phase.phase === "reasoning" ? "执行记录" : label}</span>}
            <span ref={setStatusSlot} className="tool-timeline-status" />
          </span>
          <span ref={setStatusMetaSlot} className="tool-timeline-metrics">
            {runningTool?.type === "step" && <span className="timeline-status-meta">{runningTool.tool} 调用中，等待工具返回…</span>}
          </span>
          <span className="tool-timeline-counts">
            {summary.total > 0 && <span className="tool-timeline-count">工具 {summary.total} 次</span>}
            {summary.thinking > 0 && <span className="tool-timeline-count">思考 {summary.thinking} 段</span>}
            {summary.completed > 0 && <span className="tool-timeline-count">已完成 {summary.completed}</span>}
            {summary.pending > 0 && <span className="tool-timeline-count">待完成 {summary.pending}</span>}
            {summary.awaiting > 0 && <span className="tool-timeline-count text-orange">待审批 {summary.awaiting}</span>}
          </span>
          <span className="tool-timeline-action">
            <span>{expanded ? "收起" : <>展开<span className="tool-timeline-action-detail">详情</span></>}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden
              className={`tool-timeline-action-chevron ${expanded ? "rotate-180" : ""}`}>
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      )}
      <div id={panelId} className={`relative ${summary.collapsible ? "tool-timeline-content" : activityOnly ? "tool-timeline-activity" : "pl-1"}`} data-expanded={expanded}>
        {visibleRows.length > 1 && (
          <div className="absolute w-px bg-fg/10" style={{ left: summary.collapsible ? 19 : 11, top: summary.collapsible ? 21 : 13, bottom: summary.collapsible ? 23 : 13 }} />
        )}
        <div className="flex flex-col">
          {mountedRows.map((row) => {
            const slot = !expanded && phase.rowId === row.id ? statusSlot : null;
            const metaSlot = slot ? statusMetaSlot : null;
            const onStatusClick = () => { if (groupKey !== undefined) onToggle(groupKey); };
            if (row.type === "activity") return <div key={row.id} data-timeline-row={row.id} hidden={!expanded}><CodexActivityRow statusSlot={slot} statusMetaSlot={metaSlot} onStatusClick={onStatusClick} /></div>;
            if (row.type === "thinking") {
              const statusProps = { statusSlot: slot, statusMetaSlot: metaSlot, activityId: row.id, onActivityChange: onThinkingActivity, onStatusClick };
              return <div key={row.id} data-timeline-row={row.id} hidden={!expanded}>
                {row.text.trim() ? <ThinkingBlock
                  text={row.text}
                  expanded={expandedIds.has(row.id)}
                  live={liveThinkingIds === undefined ? undefined : liveThinkingIds.has(row.id)}
                  onToggle={() => onToggle(row.id)}
                  {...statusProps}
                /> : liveThinkingIds !== undefined ?
                  <CodexActivityRow phase="reasoning" active={liveThinkingIds.has(row.id)} effort={effort} statusSlot={slot} statusMetaSlot={metaSlot} onStatusClick={onStatusClick} /> :
                  <ThinkingRow tokens={row.tokens ?? 0} effort={effort} {...statusProps} />}
              </div>;
            }
            const s = row;
            const open = expandedIds.has(s.id);
            return (
              <div key={s.id} data-tool-step={s.id} hidden={!expanded}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={open ? `${panelId}-${s.id}` : undefined}
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
                  <div className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity pr-1">
                    <Chevron open={open} />
                  </div>
                </button>
                {open && (
                  <div id={`${panelId}-${s.id}`}>
                    <StepDetails tool={s.tool} input={s.input} output={s.output} status={s.status} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
