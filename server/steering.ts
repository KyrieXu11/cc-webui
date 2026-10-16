// Per-running-turn idempotency. A browser retry must not inject the same input
// twice; changing payload under an existing messageId is an explicit conflict.
export class SteerConflict extends Error {}
export class SteeringRequests {
  private writes = new Map<string, { text: string; result: Promise<boolean> }>();
  text(id: string): string | undefined { return this.writes.get(id)?.text; }
  run(id: string, text: string, send: () => Promise<boolean>): Promise<boolean> {
    const prior = this.writes.get(id);
    if (prior) {
      if (prior.text !== text) throw new SteerConflict("messageId already used for different input");
      return prior.result;
    }
    if (this.writes.size >= 100) throw new SteerConflict("Too many additions in one turn");
    const result = Promise.resolve().then(send);
    this.writes.set(id, { text, result });
    // A definite not-ready/not-accepted result can be retried once a handle
    // appears. Unknown outcomes (transport failure) must not silently retry.
    void result.then(ok => { if (!ok && this.writes.get(id)?.result === result) this.writes.delete(id); }, () => {});
    return result;
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.writes.values()].map(w => w.result)); }
}

export function pickSteerTurn<T extends { clientTurnId?: string; threadId?: string; sessionId?: string }>(
  args: { sessionId?: string; clientTurnId?: string }, bySession: (id: string) => T | undefined, byTurn: (id: string) => T | undefined,
): T | undefined {
  // Always require the turn the caller actually saw. Never fall back from a
  // mismatched turn ID to whatever is now running in the same session.
  if (!args.clientTurnId) return undefined;
  const entry = byTurn(args.clientTurnId);
  if (!entry || args.sessionId && (entry.threadId ?? entry.sessionId) !== args.sessionId) return undefined;
  if (args.sessionId && bySession(args.sessionId) !== entry) return undefined;
  return entry;
}

export function validSteerInput(body: unknown): body is { text: string; messageId: string; sessionId?: string; clientTurnId: string } {
  const b = body as Record<string, unknown> | null;
  return !!b && typeof b.text === "string" && !!b.text.trim() && b.text.length <= 512_000 &&
    typeof b.messageId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(b.messageId) &&
    typeof b.clientTurnId === "string" && !!b.clientTurnId &&
    (b.sessionId === undefined || typeof b.sessionId === "string");
}
