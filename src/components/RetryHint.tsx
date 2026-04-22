interface Props {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus?: number | null;
}

export default function RetryHint({
  attempt,
  maxRetries,
  retryDelayMs,
  errorStatus,
}: Props) {
  const sec = Math.max(0, Math.round(retryDelayMs / 1000));
  return (
    <div className="msg-enter flex items-center gap-2 pl-1 py-1">
      <svg
        width="13"
        height="13"
        viewBox="0 0 14 14"
        fill="none"
        className="shrink-0 text-amber animate-spin origin-center"
        style={{ animationDuration: "1.2s" }}
      >
        <circle
          cx="7"
          cy="7"
          r="5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeDasharray="10 6"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-mono text-[11.5px] text-amber tracking-[0.02em]">
        Retrying in {sec}s · attempt {attempt}/{maxRetries}
        {errorStatus ? ` · HTTP ${errorStatus}` : ""}
      </span>
    </div>
  );
}
