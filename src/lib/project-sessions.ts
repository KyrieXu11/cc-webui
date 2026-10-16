import type { SessionSummary } from "./sessions";

export const RECENT_SESSION_COUNT = 5;
export const SESSION_LIST_POLL_MS = 10_000;

/** Recent activity, not creation order or which conversation was clicked. */
export function sortProjectSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.lastModified - a.lastModified);
}

export function nextSessionWindow(size: number, total: number): number {
  return Math.min(size + RECENT_SESSION_COUNT, total);
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
