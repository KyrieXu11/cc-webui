import { useState } from "react";
import { createGroup } from "../../lib/groups";
import {
  modelOptionsForProvider,
  type AgentProvider,
} from "../../lib/settings";
import type { GroupParticipant } from "../../lib/types";

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;
const MODE_OPTIONS = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const;

type Props = {
  cwd: string;
  onClose: () => void;
  onCreated: (gid: string) => void;
};

const defaultParticipant = (
  id: "claude" | "codex",
): GroupParticipant => {
  const provider: AgentProvider = id;
  const opts = modelOptionsForProvider(provider);
  const model =
    id === "claude"
      ? opts.find((m) => m.id.includes("opus"))?.id ?? opts[0]?.id ?? "claude-opus-4-7"
      : opts.find((m) => m.id.includes("codex"))?.id ?? opts[0]?.id ?? "gpt-5.3-codex";
  return {
    id,
    model,
    mode: id === "claude" ? "default" : undefined,
    effort: "medium",
    systemPrompt: "",
    skills: [],
    mcpServers: ["bash"],
  };
};

export default function NewGroupDialog({ cwd, onClose, onCreated }: Props) {
  const [title, setTitle] = useState("新群聊");
  const [groupCwd, setGroupCwd] = useState(cwd);
  const [claude, setClaude] = useState<GroupParticipant>(
    defaultParticipant("claude"),
  );
  const [codex, setCodex] = useState<GroupParticipant>(
    defaultParticipant("codex"),
  );
  const [pipeline, setPipeline] = useState<("claude" | "codex")[]>([
    "claude",
    "codex",
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!title.trim()) {
      setErr("标题不能为空");
      return;
    }
    if (!groupCwd.trim()) {
      setErr("工作目录不能为空");
      return;
    }
    setBusy(true);
    try {
      const r = await createGroup({
        title: title.trim(),
        cwd: groupCwd.trim(),
        participants: [claude, codex],
        pipeline,
      });
      onCreated(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-canvas border border-soft rounded-lg p-5 w-[680px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-semibold mb-4">新建群聊</h2>

        <Field label="标题">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-surface border border-soft rounded px-2 py-1.5 text-[14px]"
            autoFocus
          />
        </Field>

        <Field label="工作目录">
          <input
            value={groupCwd}
            onChange={(e) => setGroupCwd(e.target.value)}
            className="w-full bg-surface border border-soft rounded px-2 py-1.5 text-[13px] font-mono"
            placeholder="/Users/.../my-project"
          />
        </Field>

        <ParticipantCard
          label="Claude"
          color="purple"
          modelOptions={modelOptionsForProvider("claude").map((m) => m.id)}
          value={claude}
          onChange={setClaude}
          showMode
          rolePlaceholder="如：你是实现者，专注写代码"
        />

        <ParticipantCard
          label="Codex"
          color="emerald"
          modelOptions={modelOptionsForProvider("codex").map((m) => m.id)}
          value={codex}
          onChange={setCodex}
          rolePlaceholder="如：你是 reviewer，挑刺补 edge case"
        />

        <Field label="Pipeline 顺序（@all 时）">
          <div className="flex items-center gap-2 text-[13px]">
            {pipeline.map((p, i) => (
              <span key={i} className="px-2 py-0.5 bg-surface rounded font-mono">
                {p}
              </span>
            ))}
            <button
              type="button"
              onClick={() =>
                setPipeline(([a, b]) => [b!, a!] as ("claude" | "codex")[])
              }
              className="text-subtle text-[12px] underline ml-auto"
            >
              反转
            </button>
          </div>
        </Field>

        {err && <div className="text-red-400 text-[13px] mb-3">{err}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-subtle hover:text-fg text-[13px]"
            type="button"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy}
            type="button"
            className="px-4 py-1.5 bg-blue text-white rounded text-[13px] disabled:opacity-50"
          >
            {busy ? "创建中…" : "创建群聊"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <label className="block mb-3">
      <span className="text-[12px] text-subtle">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function ParticipantCard({
  label,
  color,
  modelOptions,
  value,
  onChange,
  showMode,
  rolePlaceholder,
}: {
  label: string;
  color: "purple" | "emerald";
  modelOptions: string[];
  value: GroupParticipant;
  onChange: (v: GroupParticipant) => void;
  showMode?: boolean;
  rolePlaceholder?: string;
}) {
  const borderClass =
    color === "purple"
      ? "border-l-2 border-l-purple-500"
      : "border-l-2 border-l-emerald-500";
  return (
    <div
      className={`bg-surface ${borderClass} rounded-r p-3 mb-3 space-y-2`}
    >
      <div className="text-[13px] font-semibold">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="text-[11px] text-subtle">模型</span>
          <select
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            className="mt-1 block w-full bg-canvas border border-soft rounded px-2 py-1 text-[12.5px] font-mono"
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-[11px] text-subtle">Effort</span>
          <select
            value={value.effort ?? "medium"}
            onChange={(e) =>
              onChange({ ...value, effort: e.target.value as any })
            }
            className="mt-1 block w-full bg-canvas border border-soft rounded px-2 py-1 text-[12.5px]"
          >
            {EFFORT_OPTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        {showMode && (
          <label className="col-span-2">
            <span className="text-[11px] text-subtle">权限模式</span>
            <select
              value={value.mode ?? "default"}
              onChange={(e) =>
                onChange({ ...value, mode: e.target.value as any })
              }
              className="mt-1 block w-full bg-canvas border border-soft rounded px-2 py-1 text-[12.5px]"
            >
              {MODE_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="block">
        <span className="text-[11px] text-subtle">系统 prompt（角色设定）</span>
        <textarea
          value={value.systemPrompt ?? ""}
          onChange={(e) =>
            onChange({ ...value, systemPrompt: e.target.value })
          }
          rows={2}
          className="mt-1 block w-full bg-canvas border border-soft rounded px-2 py-1 text-[12.5px] resize-none"
          placeholder={rolePlaceholder ?? "可选"}
        />
      </label>
    </div>
  );
}
