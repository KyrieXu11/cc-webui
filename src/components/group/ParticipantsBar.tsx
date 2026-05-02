import AgentTunePopover from "./AgentTunePopover";
import type {
  GroupAgentId,
  GroupConfig,
  GroupParticipant,
} from "../../lib/types";

const AGENT_ACCENT: Record<GroupAgentId, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#ef9d5a" },
  codex: { label: "Codex", color: "#3ecf8e" },
};

type Props = {
  config: GroupConfig;
  activeAgent?: GroupAgentId | null;
  onEdit?: () => void;
  onTuneAgent?: (
    agent: GroupAgentId,
    next: GroupParticipant,
  ) => Promise<void>;
};

export default function ParticipantsBar({
  config,
  activeAgent,
  onEdit,
  onTuneAgent,
}: Props) {
  return (
    <div className="flex items-center gap-2 h-9 px-5 border-b border-line shrink-0">
      <span className="text-[10px] font-mono text-subtle uppercase tracking-[0.1em] mr-1">
        members
      </span>
      {config.participants.map((p) => {
        const a = AGENT_ACCENT[p.id];
        const isActive = activeAgent === p.id;
        const pillContent = (
          <span
            className="inline-flex items-center gap-1.5 h-7 pl-1.5 pr-2 rounded-full border border-line-strong bg-canvas/60 hover:border-fg/25 hover:bg-fg/[0.03] transition-colors group"
            title={p.systemPrompt || `点击调整 ${a.label} 参数`}
          >
            <span
              aria-hidden
              className={`w-1.5 h-1.5 rounded-full ${
                isActive ? "pulse-dot" : ""
              }`}
              style={{
                background: a.color,
                outline: `3px solid ${a.color}22`,
                outlineOffset: 0,
                boxShadow: isActive ? `0 0 14px ${a.color}66` : undefined,
              }}
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">
              {p.id}
            </span>
            <span className="text-[11.5px] text-fg font-medium tracking-tight">
              {shortModel(p.model)}
            </span>
            {onTuneAgent && (
              <svg
                width="8"
                height="8"
                viewBox="0 0 8 8"
                fill="none"
                className="opacity-40 group-hover:opacity-80 transition-opacity"
              >
                <path
                  d="M2 3L4 5L6 3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
        );
        if (!onTuneAgent) {
          return <div key={p.id}>{pillContent}</div>;
        }
        return (
          <AgentTunePopover
            key={p.id}
            agent={p.id}
            participant={p}
            onSave={(next) => onTuneAgent(p.id, next)}
            trigger={pillContent}
          />
        );
      })}
      <div className="ml-auto flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-subtle">
          <span className="text-[10px] uppercase tracking-[0.1em]">pipeline</span>
          <span className="flex items-center gap-1.5">
            {config.pipeline.map((id, i) => (
              <span key={i} className="inline-flex items-center gap-1.5">
                {i > 0 && <span className="text-subtle/60">→</span>}
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: AGENT_ACCENT[id].color }}
                />
                <span className="text-fg/70">{id}</span>
              </span>
            ))}
          </span>
        </span>
        {onEdit && (
          <>
            <span className="w-px h-4 bg-line" aria-hidden />
            <button
              onClick={onEdit}
              type="button"
              aria-label="编辑群聊配置"
              title="编辑群聊配置（model / mode / effort / role / pipeline）"
              className="h-7 px-2 rounded-md text-subtle hover:text-fg hover:bg-fg/5 transition-colors flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em]"
            >
              <SlidersIcon />
              tune
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SlidersIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <line
        x1="2"
        y1="4"
        x2="14"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle
        cx="11"
        cy="4"
        r="1.6"
        fill="var(--color-canvas)"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line
        x1="2"
        y1="8"
        x2="14"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle
        cx="5"
        cy="8"
        r="1.6"
        fill="var(--color-canvas)"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line
        x1="2"
        y1="12"
        x2="14"
        y2="12"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle
        cx="9"
        cy="12"
        r="1.6"
        fill="var(--color-canvas)"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

// Trim model names like "claude-haiku-4-5" → "Haiku 4.5", "gpt-5.3-codex" → "GPT-5.3-Codex"
function shortModel(m: string): string {
  if (m.startsWith("claude-")) {
    const parts = m.replace(/^claude-/, "").split("-");
    const family = parts[0];
    const major = parts[1] ?? "";
    const minor = parts[2] ?? "";
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`.trim();
  }
  if (m.startsWith("gpt-")) {
    return m
      .split("-")
      .map((p) => (p === "gpt" ? "GPT" : p))
      .map((p) => (p === "codex" ? "Codex" : p))
      .map((p) => (p === "mini" ? "mini" : p))
      .join("-");
  }
  return m;
}
