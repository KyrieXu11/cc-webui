import {
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GroupQuote } from "../../lib/types";

const TARGETS = ["all", "claude", "codex"] as const;
type Target = (typeof TARGETS)[number];

const TARGET_ACCENT: Record<Target, string> = {
  all: "#5b6bff",
  claude: "#ef9d5a",
  codex: "#3ecf8e",
};

const AGENT_ACCENT: Record<"claude" | "codex", string> = {
  claude: "#ef9d5a",
  codex: "#3ecf8e",
};

const TARGET_HINT: Record<Target, string> = {
  all: "pipeline · 顺序协作",
  claude: "仅 Claude 单点",
  codex: "仅 Codex 单点",
};

type Props = {
  running: boolean;
  value: string;
  onChange: (v: string) => void;
  quote?: GroupQuote | null;
  onClearQuote?: () => void;
  onSend: (text: string, recipients: Target[]) => void;
  onStop: () => void;
  // Optional right-aligned slot in the bottom toolbar (e.g. a TasksButton
  // showing background bash counts for this group, mirroring single chat).
  rightSlot?: React.ReactNode;
};

export default function GroupComposer({
  running,
  value,
  onChange,
  quote,
  onClearQuote,
  onSend,
  onStop,
  rightSlot,
}: Props) {
  const [showMenu, setShowMenu] = useState(false);
  const [menuFilter, setMenuFilter] = useState("");
  const [menuIdx, setMenuIdx] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const filtered = useMemo(
    () => TARGETS.filter((t) => t.startsWith(menuFilter.toLowerCase())),
    [menuFilter],
  );

  useEffect(() => {
    if (filtered.length > 0 && menuIdx >= filtered.length) {
      setMenuIdx(filtered.length - 1);
    }
  }, [filtered.length, menuIdx]);

  // Auto-resize
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [value]);

  const insertMention = (target: Target) => {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const atIdx = before.lastIndexOf("@");
    const newBefore = atIdx >= 0 ? before.slice(0, atIdx) : before;
    const insert = `@${target} `;
    const next = newBefore + insert + after;
    onChange(next);
    setShowMenu(false);
    setMenuFilter("");
    queueMicrotask(() => {
      ta.focus();
      const newPos = newBefore.length + insert.length;
      ta.selectionStart = newPos;
      ta.selectionEnd = newPos;
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    onChange(v);
    const pos = e.target.selectionStart;
    const before = v.slice(0, pos);
    const m = before.match(/@([a-z]*)$/);
    if (m) {
      setShowMenu(true);
      setMenuFilter(m[1]);
      setMenuIdx(0);
    } else {
      setShowMenu(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMenu && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIdx((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(filtered[menuIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMenu(false);
        return;
      }
    }
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      submit();
    }
  };

  // First @<target> at the start of message determines recipients;
  // body is everything after it (so the receiving agent doesn't see the @).
  // When a quote is attached and the user didn't explicitly @-mention,
  // default the recipient to the quoted agent (intent: "ask the quoted
  // agent to look at their own thing"), instead of falling back to @all.
  const parse = (
    raw: string,
  ): { text: string; recipients: Target[] } => {
    const trimmed = raw.replace(/^\s+/, "");
    const m = trimmed.match(/^@(claude|codex|all)(\s+|$)/i);
    if (!m) {
      const fallback: Target = quote ? (quote.agent as Target) : "all";
      return { text: raw.trim(), recipients: [fallback] };
    }
    const target = m[1].toLowerCase() as Target;
    return {
      text: trimmed.slice(m[0].length).trim(),
      recipients: [target],
    };
  };

  const submit = () => {
    if (running) return;
    if (!value.trim()) return;
    const { text, recipients } = parse(value);
    if (!text) return;
    onSend(text, recipients);
    onChange("");
  };

  const canSend = !running && value.trim().length > 0;

  return (
    <div className="px-6 pb-5 pt-2">
      {quote && quote.text && (
        <div className="mb-1.5 flex items-start gap-2 bg-canvas border border-line-strong rounded-lg px-3 py-1.5">
          <div
            className="w-0.5 self-stretch shrink-0 rounded-sm"
            style={{
              background: AGENT_ACCENT[quote.agent as "claude" | "codex"],
            }}
          />
          <div className="min-w-0 flex-1">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.12em] mb-0.5"
              style={{
                color: AGENT_ACCENT[quote.agent as "claude" | "codex"],
              }}
            >
              引用 {quote.agent} 的回复
            </div>
            <div className="text-[12px] text-muted leading-[1.5] line-clamp-2">
              {quote.text}
            </div>
          </div>
          <button
            type="button"
            onClick={onClearQuote}
            aria-label="移除引用"
            className="text-subtle hover:text-fg p-0.5 rounded shrink-0 transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path
                d="M3 3L9 9M9 3L3 9"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      )}
      <div className="relative bg-raised border border-line-strong rounded-2xl transition-colors focus-within:border-fg/25">
        {showMenu && filtered.length > 0 && (
          <div className="absolute left-2 right-2 bottom-full mb-2 bg-surface border border-line-strong rounded-lg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)] overflow-hidden z-50">
            <div className="px-3 py-1.5 text-[10px] font-mono text-subtle uppercase tracking-[0.08em] border-b border-line flex items-center justify-between">
              <span>mention 收件人</span>
              <span className="text-subtle/60">↑↓ · ↵ 选择 · esc 取消</span>
            </div>
            <div className="py-1">
              {filtered.map((t, i) => {
                const active = i === menuIdx;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => insertMention(t)}
                    onMouseEnter={() => setMenuIdx(i)}
                    className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 font-mono text-[12.5px] transition-colors ${
                      active ? "bg-blue/[0.15] text-fg" : "text-muted hover:text-fg"
                    }`}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{
                        background: TARGET_ACCENT[t],
                        outline: `3px solid ${TARGET_ACCENT[t]}22`,
                      }}
                    />
                    <span className="text-subtle">@</span>
                    <span>{t}</span>
                    <span className="ml-auto text-[10.5px] text-subtle/80 normal-case tracking-normal font-sans">
                      {TARGET_HINT[t]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <textarea
          ref={taRef}
          value={value}
          onChange={handleChange}
          onKeyDown={onKey}
          placeholder={
            quote
              ? "针对引用提问…    ↵ 发送 · ⇧↵ 换行"
              : "@all (流水线) / @claude / @codex …    ↵ 发送 · ⇧↵ 换行"
          }
          rows={1}
          disabled={running}
          className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[14.5px] leading-[1.6] text-fg placeholder:text-subtle focus:outline-none disabled:opacity-50"
        />

        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <div className="flex items-center gap-2 px-2">
            <span className="font-mono text-[10.5px] text-subtle">
              {running
                ? "thinking…"
                : value.trim() === ""
                  ? "idle"
                  : detectTarget(value, quote ?? undefined)}
            </span>
            {rightSlot}
          </div>
          {running ? (
            <button
              onClick={onStop}
              type="button"
              aria-label="停止生成"
              title="停止生成"
              className="w-9 h-9 rounded-full bg-red hover:brightness-110 flex items-center justify-center transition-all active:scale-95"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <rect x="2" y="2" width="8" height="8" rx="1.5" fill="white" />
              </svg>
            </button>
          ) : (
            <button
              onClick={submit}
              type="button"
              disabled={!canSend}
              aria-label="发送"
              className="w-9 h-9 rounded-full bg-blue hover:bg-blue-hover disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all active:scale-95"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 13V3M8 3L3.5 7.5M8 3L12.5 7.5"
                  stroke="white"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function detectTarget(value: string, quote?: GroupQuote | null): string {
  const trimmed = value.replace(/^\s+/, "");
  const m = trimmed.match(/^@(claude|codex|all)(\s|$)/i);
  if (!m) {
    if (quote) return `→ @${quote.agent} (引用)`;
    return "→ @all (default)";
  }
  return `→ @${m[1].toLowerCase()}`;
}
