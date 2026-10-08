import type { ChatEvent } from "./types";

// The same visual row serves reasoning activity and Codex turn liveness.
// Never label the latter as a measured thought.
export function activityLabel(active: boolean, word: string, totalTurn?: boolean): string {
  return active ? `${word}…` : totalTurn ? "已结束" : "thought";
}

export function formatActivityElapsed(seconds: number, totalTurn?: boolean): string {
  const duration = seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  // This includes model waiting and tools; it is NOT reasoning duration.
  return totalTurn ? `回合已用 ${duration}` : duration;
}

// Codex 的状态和整轮统计单独表达；原 activityLabel/formatActivityElapsed
// 仍供 Claude 的真实 token 活动行使用，不改变其计时、动词或显示格式。
export function codexActivityLabel(active: boolean, word: string, phase: "processing" | "reasoning"): string {
  if (!active) return phase === "reasoning" ? "thought" : "已结束";
  // Keep the visible feedback compact; phase semantics stay in aria-label/title.
  // The decorative verb is not a measured reasoning indicator.
  return `${word}…`;
}
export function formatTurnElapsed(seconds: number): string {
  return `本轮总耗时 ${formatActivityElapsed(seconds)}`;
}

// 只从服务端的本轮 startedAt 算累计耗时。没有时间戳时不能拿组件挂载时间
// 冒充整轮起点（切会话/刷新/群聊都可能在半路才挂载）。
export function turnElapsedSeconds(startedAt: number | undefined, now = Date.now()): number | null {
  if (startedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

// This is liveness, NOT a synthetic reasoning event. Codex exec does not emit
// reasoning deltas; a live turn without an executing tool still needs feedback.
export function currentTurnEvents(events: ChatEvent[]): ChatEvent[] {
  let lastUser = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "user") { lastUser = i; break; }
  }
  return events.slice(lastUser + 1);
}
export function liveToolIds(events: ChatEvent[], running: boolean): Set<string> {
  const turn = currentTurnEvents(events);
  const awaiting = new Set(turn.flatMap(e => e.type === "permission" && e.resolved === undefined && !e.stale && e.toolUseId ? [`s-${e.toolUseId}`] : []));
  return new Set(running ? turn.filter(e => e.type === "step" && e.status === "pending" && !awaiting.has(e.id)).map(e => e.id) : []);
}
export function liveThinkingIds(events: ChatEvent[], running: boolean): Set<string> {
  if (!running) return new Set();
  const turn = currentTurnEvents(events);
  if (turn.some(e => e.type === "step" && e.status === "pending" ||
    e.type === "permission" && e.resolved === undefined && !e.stale)) return new Set();
  // Only an explicit pending reasoning item is evidence of live reasoning.
  // A later tool/reply also ends this UI phase: do not revive an old pending
  // reasoning item after the tool completes. Empty summaries still count.
  const latest = turn.at(-1);
  return new Set(latest?.type === "thinking" && latest.status === "pending" ? [latest.id] : []);
}
export function showCodexActivity(events: ChatEvent[], running: boolean): boolean {
  if (!running) return false;
  const turn = currentTurnEvents(events);
  return liveThinkingIds(events, running).size === 0 && !turn.some(e => e.type === "step" && e.status === "pending" || e.type === "permission" && e.resolved === undefined && !e.stale);
}
