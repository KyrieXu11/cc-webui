// Transient status, not an assistant message. Only native public error fields
// cross this boundary; no invented retry counts, timers or raw reasoning.
export type CodexRetryFrame = {
  type: "codex_retry";
  turn_id: string;
  status: "retrying" | "resumed" | "ended";
  message?: string;
  details?: string;
  httpStatusCode?: number;
};

export type CodexRetryInfo = {
  kind: "codex";
  turnId: string;
  message: string;
  details?: string;
  httpStatusCode?: number;
};

export type ClaudeRetryInfo = {
  kind?: "claude";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
};
export type RetryInfo = ClaudeRetryInfo | CodexRetryInfo;

export function isCodexRetryFrame(value: unknown): value is CodexRetryFrame {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return f.type === "codex_retry" && typeof f.turn_id === "string" && !!f.turn_id &&
    ["retrying", "resumed", "ended"].includes(f.status as string) &&
    (f.message === undefined || typeof f.message === "string") &&
    (f.details === undefined || typeof f.details === "string");
}

export function applyCodexRetryFrame(current: RetryInfo | null, frame: CodexRetryFrame): RetryInfo | null {
  if (frame.status !== "retrying") return current?.kind === "codex" && current.turnId === frame.turn_id ? null : current;
  return { kind: "codex", turnId: frame.turn_id,
    message: frame.message ?? "Codex 正在自动重试模型请求",
    ...(frame.details ? { details: frame.details } : {}),
    ...(Number.isInteger(frame.httpStatusCode) && frame.httpStatusCode! >= 100 && frame.httpStatusCode! <= 599
      ? { httpStatusCode: frame.httpStatusCode } : {}),
  };
}
