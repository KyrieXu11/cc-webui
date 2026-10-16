import type { AgentProvider } from "./settings";
import type { SessionSummary } from "./sessions";

export const RECENT_SESSION_COUNT = 5;
export const SESSION_LIST_POLL_MS = 10_000;

/** Keep the open conversation visible even when it is older than the recent five. */
export function collapsedProjectSessions(
  sessions: SessionSummary[],
  provider: AgentProvider,
  sessionId: string | null,
): SessionSummary[] {
  return sessions.filter((s, index) => index < RECENT_SESSION_COUNT ||
    s.provider === provider && s.sessionId === sessionId);
}

/** One read at a time; a disposed scope must never publish a late response. */
export function createSessionListLoader({ read, onRows, onError, onSettled }: {
  read: (signal: AbortSignal) => Promise<SessionSummary[]>;
  onRows: (rows: SessionSummary[]) => void;
  onError: () => void;
  onSettled: () => void;
}) {
  let disposed = false;
  let controller: AbortController | null = null;
  return {
    async refresh() {
      if (disposed || controller) return;
      const request = new AbortController();
      controller = request;
      try {
        const rows = await read(request.signal);
        if (!disposed) onRows(rows);
      } catch {
        if (!disposed) onError();
      } finally {
        controller = null;
        if (!disposed) onSettled();
      }
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
