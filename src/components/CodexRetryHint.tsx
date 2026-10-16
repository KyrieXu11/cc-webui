import type { CodexRetryInfo } from "../../shared/codex-retry";

export default function CodexRetryHint({ info }: { info: CodexRetryInfo }) {
  return (
    <div data-codex-retry="true" role="status" aria-live="polite" className="msg-enter flex items-start gap-2 pl-1 py-1">
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none"
        className="mt-0.5 shrink-0 text-amber animate-spin motion-reduce:animate-none origin-center" style={{ animationDuration: "1.2s" }}>
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="10 6" strokeLinecap="round" />
      </svg>
      <div className="min-w-0 text-[11.5px]">
        <div className="font-mono text-amber tracking-[0.02em]">
          Codex 正在自动重试{info.httpStatusCode ? ` · HTTP ${info.httpStatusCode}` : ""}
        </div>
        <p className="mt-1 text-muted whitespace-pre-wrap break-words">{info.message}</p>
        {info.details && <details className="mt-1 text-muted">
          <summary className="cursor-pointer">查看原生原因</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{info.details}</p>
        </details>}
      </div>
    </div>
  );
}
