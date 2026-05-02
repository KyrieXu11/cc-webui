import { useState } from "react";
import Popover from "../Popover";
import ModelSelector from "../ModelSelector";
import ModeSelector from "../ModeSelector";
import EffortSelector from "../EffortSelector";
import type { EffortLevel, PermissionMode } from "../../lib/settings";
import type { GroupAgentId, GroupParticipant } from "../../lib/types";

const AGENT_ACCENT: Record<GroupAgentId, string> = {
  claude: "#ef9d5a",
  codex: "#3ecf8e",
};

type Props = {
  agent: GroupAgentId;
  participant: GroupParticipant;
  onSave: (next: GroupParticipant) => Promise<void>;
  trigger: React.ReactNode;
};

export default function AgentTunePopover({
  agent,
  participant,
  onSave,
  trigger,
}: Props) {
  return (
    <Popover
      align="left"
      direction="down"
      width={340}
      triggerClassName="inline-flex items-center focus:outline-none rounded-full"
      trigger={trigger}
    >
      {({ close }) => (
        <PopoverBody
          agent={agent}
          participant={participant}
          onSave={onSave}
          close={close}
        />
      )}
    </Popover>
  );
}

function ParamRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 h-7 px-1.5 rounded-md hover:bg-fg/[0.02] transition-colors">
      <span className="text-[11px] text-fg font-mono uppercase tracking-[0.1em] shrink-0">
        {label}
      </span>
      <div className="flex items-center min-w-0">{children}</div>
    </div>
  );
}

function PopoverBody({
  agent,
  participant,
  onSave,
  close,
}: {
  agent: GroupAgentId;
  participant: GroupParticipant;
  onSave: (next: GroupParticipant) => Promise<void>;
  close: () => void;
}) {
  const [draft, setDraft] = useState<GroupParticipant>(participant);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const accent = AGENT_ACCENT[agent];
  const dirty = JSON.stringify(draft) !== JSON.stringify(participant);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onSave(draft);
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-3">
      {/* header */}
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-line">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background: accent,
            outline: `3px solid ${accent}22`,
          }}
        />
        <span
          className="font-mono text-[10.5px] uppercase tracking-[0.12em]"
          style={{ color: accent }}
        >
          {agent}
        </span>
        <span className="font-mono text-[10.5px] text-subtle/80 truncate">
          {draft.model}
        </span>
        <button
          onClick={close}
          aria-label="关闭"
          className="ml-auto text-subtle hover:text-fg p-0.5 rounded transition-colors"
          type="button"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M3 3L9 9M9 3L3 9"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* params: each row labelled with mono uppercase tag like form fields */}
      <div className="space-y-1 mb-3">
        <ParamRow label="模型">
          <ModelSelector
            provider={agent}
            value={draft.model}
            onChange={(model) => setDraft({ ...draft, model })}
            direction="down"
            align="right"
          />
        </ParamRow>
        {agent === "claude" && (
          <ParamRow label="权限模式">
            <ModeSelector
              value={(draft.mode ?? "default") as PermissionMode}
              onChange={(mode) => setDraft({ ...draft, mode })}
              direction="down"
              align="right"
            />
          </ParamRow>
        )}
        <ParamRow label="effort">
          <EffortSelector
            value={(draft.effort ?? "medium") as EffortLevel}
            model={draft.model}
            onChange={(effort) => setDraft({ ...draft, effort })}
            direction="down"
            align="right"
          />
        </ParamRow>
      </div>

      {/* system prompt — px-1.5 aligns the label with ParamRow labels above */}
      <div className="mb-3 px-1.5">
        <span className="text-[11px] text-fg font-mono uppercase tracking-[0.1em] block mb-1.5">
          system prompt（角色设定）
        </span>
        <textarea
          value={draft.systemPrompt ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, systemPrompt: e.target.value })
          }
          rows={3}
          placeholder={
            agent === "claude"
              ? "如：你是实现者，专注写代码"
              : "如：你是 reviewer，挑刺补 edge case"
          }
          className="w-full bg-canvas border border-line rounded-md px-2.5 py-1.5 text-[12.5px] text-fg placeholder:text-subtle resize-none focus:outline-none focus:border-fg/25 transition-colors"
        />
      </div>

      {err && (
        <div className="mb-3 amber-card rounded-md px-2.5 py-1.5 text-[11.5px] text-fg font-mono">
          {err}
        </div>
      )}

      {/* footer */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.1em] mr-auto ${
            dirty ? "text-amber" : "text-subtle"
          }`}
        >
          {dirty ? "modified · 未保存" : "synced"}
        </span>
        <button
          onClick={close}
          type="button"
          className="h-7 px-2.5 rounded-md text-[12px] text-muted hover:text-fg hover:bg-fg/5 transition-colors"
        >
          取消
        </button>
        <button
          onClick={submit}
          type="button"
          disabled={busy || !dirty}
          className="h-7 px-3 rounded-md bg-blue hover:bg-blue-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-medium tracking-tight transition-colors flex items-center gap-1.5"
        >
          {busy ? (
            <>
              <span className="w-1 h-1 rounded-full bg-white animate-pulse" />
              saving…
            </>
          ) : (
            "保存"
          )}
        </button>
      </div>
    </div>
  );
}
