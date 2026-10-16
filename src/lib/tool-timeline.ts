import type { ChatEvent } from "./types";

export type TimelineRow = Extract<ChatEvent, { type: "step" | "thinking" }> | {
  id: string;
  type: "activity";
};

// 独立于单条工具详情；收起整个组不会丢掉已经展开的 diff / 输出。
export function toolTimelineKey(stepId: string): string {
  return `tool-timeline:${stepId}`;
}

export function summarizeToolTimeline(rows: TimelineRow[], awaitingPermission?: Set<string>) {
  let total = 0, completed = 0, failed = 0, pending = 0, awaiting = 0, thinking = 0;
  for (const row of rows) {
    if (row.type === "thinking") thinking++;
    if (row.type !== "step") continue;
    total++;
    if (awaitingPermission?.has(row.id)) awaiting++;
    else if (row.status === "ok") completed++;
    else if (row.status === "error") failed++;
    else pending++;
  }
  return {
    total, completed, failed, pending, awaiting, thinking,
    collapsible: total + thinking > 0,
    key: rows[0] === undefined ? undefined : toolTimelineKey(rows[0].id),
  };
}

// 工具与思考记录一起收起；实时状态移到摘要、审批卡由 MessageList 独立展示。
export function visibleTimelineRows(rows: TimelineRow[], expanded: boolean): TimelineRow[] {
  return expanded ? rows : [];
}

// 思考与未完成工具只隐藏而不卸载，避免重新展开时重置原组件的等待/思考时钟。
// 成功/失败的历史工具不挂载，长时间线仍能减少 DOM 和 diff 渲染开销。
export function mountedTimelineRows(rows: TimelineRow[], expanded: boolean): TimelineRow[] {
  return expanded ? rows : rows.filter(row => row.type !== "step" || row.status === "pending");
}

// Ctrl+O 的全展开既要打开工具/思考详情，也要打开包着它的组。每个记录加一个组 key，
// 无需在快捷键里重新实现 MessageList 的分组/空事件过滤规则。
export function toolExpansionIds(events: ChatEvent[]): string[] {
  return events.flatMap(ev => ev.type === "step" || ev.type === "thinking" ? [ev.id, toolTimelineKey(ev.id)] : []);
}

export function timelinePhase(rows: TimelineRow[], state: {
  executingIds?: Set<string>;
  awaitingPermission?: Set<string>;
  liveThinkingIds?: Set<string>;
  thinkingCandidateId?: string;
  observedThinkingIds?: Set<string>;
}) {
  if (rows.some(row => row.type === "step" && row.status === "pending" && state.executingIds?.has(row.id))) return { phase: "tools" as const };
  if (rows.some(row => row.type === "step" && state.awaitingPermission?.has(row.id))) return { phase: "approval" as const };
  const thought = rows.find(row => row.type === "thinking" && (state.liveThinkingIds?.has(row.id) ||
    state.liveThinkingIds === undefined && row.id === state.thinkingCandidateId && state.observedThinkingIds?.has(row.id)));
  if (thought) return { phase: "reasoning" as const, rowId: thought.id };
  const activity = rows.find(row => row.type === "activity");
  return activity ? { phase: "processing" as const, rowId: activity.id } : { phase: "idle" as const };
}
