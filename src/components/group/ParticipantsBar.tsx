import type { GroupConfig } from "../../lib/types";

const AGENT_BADGE: Record<string, { label: string; cls: string }> = {
  claude: { label: "Claude", cls: "border-l-purple-500 bg-purple-500/10" },
  codex: { label: "Codex", cls: "border-l-emerald-500 bg-emerald-500/10" },
};

type Props = {
  config: GroupConfig;
  activeAgent?: string | null;
};

export default function ParticipantsBar({ config, activeAgent }: Props) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-soft text-[12px] font-mono">
      {config.participants.map((p) => {
        const b = AGENT_BADGE[p.id] ?? {
          label: p.id,
          cls: "border-l-zinc-500 bg-zinc-500/10",
        };
        const isActive = activeAgent === p.id;
        return (
          <span
            key={p.id}
            className={`px-2 py-0.5 rounded border-l-2 ${b.cls} ${
              isActive ? "ring-1 ring-amber-400" : ""
            }`}
            title={p.systemPrompt || ""}
          >
            {b.label} · {p.model}
            {p.systemPrompt ? " · 角色: " + truncate(p.systemPrompt, 24) : ""}
            {isActive && <span className="ml-1 text-amber-400">●</span>}
          </span>
        );
      })}
      <span className="ml-auto text-subtle">
        pipeline: {config.pipeline.join(" → ")}
      </span>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
