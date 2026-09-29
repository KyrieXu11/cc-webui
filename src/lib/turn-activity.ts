import type { ChatEvent } from "./types";

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
export function showCodexActivity(events: ChatEvent[], running: boolean): boolean {
  if (!running) return false;
  const turn = currentTurnEvents(events);
  return !turn.some(e => e.type === "step" && e.status === "pending" || e.type === "permission" && e.resolved === undefined && !e.stale || e.type === "thinking" && e.status === "pending" && !!e.text.trim());
}
