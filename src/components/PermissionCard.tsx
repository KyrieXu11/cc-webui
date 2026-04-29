import { useState } from "react";
import type { PermissionDecision } from "../lib/types";

interface Props {
  tool: string;
  input: Record<string, any>;
  resolved?: PermissionDecision;
  title?: string;
  description?: string;
  hasSessionPermissionSuggestions?: boolean;
  delay?: number;
  onAnswer: (decision: PermissionDecision, message?: string) => void;
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

const RESOLVED_LABEL: Record<PermissionDecision, string> = {
  allow: "已允许本次",
  allow_session: "已按规则允许本会话",
  allow_tool_session: "已允许同名工具",
  deny: "已拒绝",
};

export default function PermissionCard({
  tool,
  input,
  resolved,
  title,
  description,
  hasSessionPermissionSuggestions = false,
  delay = 0,
  onAnswer,
}: Props) {
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const locked = resolved !== undefined;
  const summary = summarizeInput(tool, input);

  const btnBase =
    "px-3 h-8 rounded-md text-[12.5px] border transition-all duration-150 whitespace-nowrap";
  const btnIdle =
    "bg-canvas/50 border-fg/10 text-muted hover:text-fg hover:border-fg/25 hover:bg-raised";
  const btnLocked = "bg-transparent border-fg/5 text-subtle cursor-default";

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
        {locked && (
          <span className="ml-auto font-mono text-[10.5px] text-subtle">
            {RESOLVED_LABEL[resolved!]}
          </span>
        )}
      </div>

      {(title || description) && (
        <div className="mb-3">
          {title && <div className="text-[13px] text-fg">{title}</div>}
          {description && (
            <div className="mt-1 text-[12px] leading-relaxed text-muted">
              {description}
            </div>
          )}
        </div>
      )}

      {summary && (
        <pre className="bg-canvas/50 border border-fg/10 rounded-md p-2.5 mb-4 max-h-[9em] overflow-y-auto font-mono text-[12px] leading-[1.55] text-muted whitespace-pre-wrap break-all">
          {summary}
        </pre>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={locked}
          onClick={() => onAnswer("allow")}
          className={`${btnBase} ${
            resolved === "allow"
              ? "bg-blue border-blue text-white"
              : locked
                ? btnLocked
                : btnIdle
          }`}
        >
          允许本次
        </button>
        <button
          disabled={locked}
          onClick={() => onAnswer("allow_session")}
          className={`${btnBase} ${
            resolved === "allow_session"
              ? "bg-blue border-blue text-white"
              : locked
                ? btnLocked
                : btnIdle
          }`}
          title={
            hasSessionPermissionSuggestions
              ? "按 Claude Code 建议的会话规则放行同类请求"
              : "当前请求没有 Claude Code 会话规则，将按同一工具和同一输入放行"
          }
        >
          按规则允许本会话
        </button>
        <button
          disabled={locked}
          onClick={() => onAnswer("allow_tool_session")}
          className={`${btnBase} ${
            resolved === "allow_tool_session"
              ? "bg-blue border-blue text-white"
              : locked
                ? btnLocked
                : btnIdle
          }`}
          title={`本次 WebUI 会话内所有 ${tool} 调用都自动放行`}
        >
          同名工具都允许
        </button>
        <button
          disabled={locked}
          onClick={() => onAnswer("deny", reason.trim() || undefined)}
          className={`${btnBase} ${
            resolved === "deny"
              ? "bg-surface border-fg/40 text-fg"
              : locked
                ? btnLocked
                : btnIdle
          }`}
        >
          拒绝
        </button>
        {!locked && !showReason && (
          <button
            onClick={() => setShowReason(true)}
            className="ml-auto text-[11.5px] text-subtle hover:text-fg transition-colors"
          >
            + 添加拒绝说明
          </button>
        )}
      </div>

      {showReason && !locked && (
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="拒绝理由（会回传给 Claude）…"
          className="mt-3 w-full h-9 px-3 rounded-md bg-canvas/50 border border-fg/10 text-[12.5px] text-fg placeholder:text-subtle focus:outline-none focus:border-fg/25 transition-colors"
        />
      )}
    </div>
  );
}
