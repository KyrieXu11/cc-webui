import { useState } from "react";

interface Props {
  tool: string;
  input: Record<string, any>;
  resolved?: "allow" | "deny";
  delay?: number;
  onAnswer: (decision: "allow" | "deny", message?: string) => void;
}

function summarizeInput(tool: string, input: Record<string, any>): string {
  if (!input || typeof input !== "object") return "";
  switch (tool) {
    case "Bash":
      return input.command ?? "";
    case "Read":
    case "Write":
    case "Edit":
      return input.file_path ?? "";
    case "Grep":
      return input.pattern ? `/${input.pattern}/` : "";
    case "Glob":
      return input.pattern ?? "";
    case "WebFetch":
      return input.url ?? "";
    case "WebSearch":
      return input.query ?? "";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return typeof first === "string" ? first : JSON.stringify(input);
    }
  }
}

export default function PermissionCard({
  tool,
  input,
  resolved,
  delay = 0,
  onAnswer,
}: Props) {
  const [reason, setReason] = useState("");
  const locked = resolved !== undefined;
  const summary = summarizeInput(tool, input);

  return (
    <div
      className="msg-enter amber-card rounded-lg p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[10.5px] font-mono text-amber uppercase tracking-[0.1em]">
          权限请求
        </div>
        <span className="text-subtle">·</span>
        <span className="font-mono text-[12.5px] text-fg">{tool}</span>
      </div>
      {summary && (
        <pre className="bg-canvas/50 border border-fg/10 rounded-md p-2.5 mb-4 overflow-x-auto font-mono text-[12px] leading-[1.55] text-muted whitespace-pre-wrap break-all">
          {summary}
        </pre>
      )}
      <div className="text-[13px] text-muted leading-[1.7] mb-3">
        是否允许执行以上 <span className="font-mono text-fg">{tool}</span>？
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        <button
          disabled={locked}
          onClick={() => onAnswer("allow")}
          className={`px-3.5 h-8 rounded-md text-[13px] border transition-all duration-150 ${
            resolved === "allow"
              ? "bg-blue border-blue text-white"
              : locked
                ? "bg-transparent border-fg/5 text-subtle"
                : "bg-canvas/50 border-fg/10 text-muted hover:text-fg hover:border-fg/25 hover:bg-raised"
          }`}
        >
          允许本次
        </button>
        <button
          disabled={locked}
          onClick={() => onAnswer("deny", reason.trim() || undefined)}
          className={`px-3.5 h-8 rounded-md text-[13px] border transition-all duration-150 ${
            resolved === "deny"
              ? "bg-surface border-fg/40 text-fg"
              : locked
                ? "bg-transparent border-fg/5 text-subtle"
                : "bg-canvas/50 border-fg/10 text-muted hover:text-fg hover:border-fg/25 hover:bg-raised"
          }`}
        >
          拒绝
        </button>
      </div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={locked}
        placeholder="拒绝理由（可选，会回传给 Claude）…"
        className="w-full h-9 px-3 rounded-md bg-canvas/50 border border-fg/10 text-[12.5px] text-fg placeholder:text-subtle focus:outline-none focus:border-fg/25 disabled:opacity-50 transition-colors"
      />
    </div>
  );
}
