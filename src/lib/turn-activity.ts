import type { ChatEvent } from "./types";

// The same visual row serves reasoning activity and Codex turn liveness.
// Never label the latter as a measured thought.
export function activityLabel(active: boolean, word: string, totalTurn?: boolean): string {
  return totalTurn ? "处理中…" : active ? `${word}…` : "thought";
}

export function formatActivityElapsed(seconds: number, totalTurn?: boolean): string {
  const duration = seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  // This includes model waiting and tools; it is NOT reasoning duration.
  return totalTurn ? `回合已用 ${duration}` : duration;
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
