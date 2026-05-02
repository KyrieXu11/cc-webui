import { useEffect, useState } from "react";
import { createGroup, updateGroupConfig } from "../../lib/groups";
import {
  modelOptionsForProvider,
  type AgentProvider,
  type EffortLevel,
  type PermissionMode,
} from "../../lib/settings";
import ModelSelector from "../ModelSelector";
import ModeSelector from "../ModeSelector";
import EffortSelector from "../EffortSelector";
import OpenProjectDialog from "../OpenProjectDialog";
import { tildify, getHome } from "../../lib/fs";
import type { GroupConfig, GroupParticipant } from "../../lib/types";

const AGENT_ACCENT: Record<"claude" | "codex", string> = {
  claude: "#ef9d5a",
  codex: "#3ecf8e",
};

const defaultParticipant = (id: "claude" | "codex"): GroupParticipant => {
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

type Mode =
  | { kind: "create"; cwd: string; onCreated: (gid: string) => void }
  | { kind: "edit"; initial: GroupConfig; onSaved: () => void };

type Props = {
  mode: Mode;
  onClose: () => void;
};

export default function GroupConfigDialog({ mode, onClose }: Props) {
  const isEdit = mode.kind === "edit";

  const initialClaude =
    isEdit
      ? mode.initial.participants.find((p) => p.id === "claude") ??
        defaultParticipant("claude")
      : defaultParticipant("claude");
  const initialCodex =
    isEdit
      ? mode.initial.participants.find((p) => p.id === "codex") ??
        defaultParticipant("codex")
      : defaultParticipant("codex");

  const [title, setTitle] = useState(
    isEdit ? mode.initial.title : "新群聊",
  );
  const [groupCwd, setGroupCwd] = useState(
    isEdit ? mode.initial.cwd : mode.cwd,
  );
  const [claude, setClaude] = useState<GroupParticipant>(initialClaude);
  const [codex, setCodex] = useState<GroupParticipant>(initialCodex);
  const [pipeline, setPipeline] = useState<("claude" | "codex")[]>(
    isEdit ? (mode.initial.pipeline as any) : ["claude", "codex"],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickingCwd, setPickingCwd] = useState(false);
  const [home, setHome] = useState("");

  useEffect(() => {
    getHome().then(setHome).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't close outer dialog when nested project picker is open
      // (OpenProjectDialog handles ESC itself).
      if (e.key === "Escape" && !pickingCwd) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, pickingCwd]);

  const submit = async () => {
    setErr(null);
    if (!title.trim()) return setErr("标题不能为空");
    if (!groupCwd.trim()) return setErr("工作目录不能为空");
    setBusy(true);
    try {
      if (mode.kind === "create") {
        const r = await createGroup({
          title: title.trim(),
          cwd: groupCwd.trim(),
          participants: [claude, codex],
          pipeline,
        });
        mode.onCreated(r.id);
      } else {
        // cwd intentionally NOT sent in edit mode — locked once the group
        // exists to keep the resumed agent sessions consistent with
        // canonical (they were started under the original cwd).
        await updateGroupConfig(mode.initial.id, {
          title: title.trim(),
          participants: [claude, codex],
          pipeline,
        });
        mode.onSaved();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const headerLabel = isEdit ? "编辑群聊" : "新建群聊";
  const submitLabel = isEdit ? "保存" : "创建群聊";
  const busyLabel = isEdit ? "saving…" : "creating…";

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[8vh] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[640px] bg-surface border border-line-strong rounded-xl overflow-hidden shadow-[0_28px_80px_-20px_rgba(0,0,0,0.85)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div className="flex items-center gap-2.5">
            <div className="flex -space-x-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  background: AGENT_ACCENT.claude,
                  outline: `2px solid var(--color-surface)`,
                }}
              />
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  background: AGENT_ACCENT.codex,
                  outline: `2px solid var(--color-surface)`,
                }}
              />
            </div>
            <h3 className="text-fg text-[15px] font-semibold tracking-tight">
              {headerLabel}
            </h3>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">
              claude × codex
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-subtle hover:text-fg p-1 rounded transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M3 3L11 11M11 3L3 11"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[72vh] overflow-y-auto">
          <section>
            <SectionLabel>会话基础</SectionLabel>
            <div className="space-y-2.5">
              <Field label="标题">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full bg-raised border border-line-strong rounded-md px-3 py-2 text-[13.5px] text-fg placeholder:text-subtle focus:outline-none focus:border-fg/30 transition-colors"
                  autoFocus
                />
              </Field>
              <Field label="工作目录">
                {isEdit ? (
                  // Locked once the group exists — switching cwd mid-
                  // conversation would desync the resumed agent sessions
                  // (still running under the old cwd) from canonical.
                  <div
                    className="w-full bg-raised border border-line rounded-md px-3 py-2 font-mono text-[12.5px] text-muted flex items-center justify-between gap-2 cursor-not-allowed"
                    title="已有群聊不可改动工作目录（避免与已 resume 的 agent session 不一致）"
                  >
                    <span className="truncate">
                      {tildify(groupCwd, home) || groupCwd}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 14 14"
                      fill="none"
                      className="text-subtle/60 shrink-0"
                    >
                      <rect
                        x="3"
                        y="6"
                        width="8"
                        height="6"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                      <path
                        d="M5 6V4.5C5 3.4 5.9 2.5 7 2.5C8.1 2.5 9 3.4 9 4.5V6"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPickingCwd(true)}
                    className="w-full bg-raised border border-line-strong rounded-md px-3 py-2 font-mono text-[12.5px] text-fg placeholder:text-subtle hover:border-fg/30 transition-colors flex items-center justify-between gap-2 text-left"
                  >
                    <span className="truncate">
                      {groupCwd ? (
                        tildify(groupCwd, home)
                      ) : (
                        <span className="text-subtle">未选择，点击选择项目目录…</span>
                      )}
                    </span>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 14 14"
                      fill="none"
                      className="text-subtle shrink-0"
                    >
                      <path
                        d="M1.5 4V11C1.5 11.55 1.95 12 2.5 12H11.5C12.05 12 12.5 11.55 12.5 11V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 3H2.5C1.95 3 1.5 3.45 1.5 4Z"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </Field>
            </div>
          </section>

          <section>
            <SectionLabel>参与者配置</SectionLabel>
            <div className="space-y-2.5">
              <ParticipantCard
                agent="claude"
                value={claude}
                onChange={setClaude}
                showMode
                rolePlaceholder="如：你是实现者，专注写代码"
              />
              <ParticipantCard
                agent="codex"
                value={codex}
                onChange={setCodex}
                rolePlaceholder="如：你是 reviewer，挑刺补 edge case"
              />
            </div>
          </section>

          <section>
            <SectionLabel>@all 流水线顺序</SectionLabel>
            <div className="flex items-center gap-2 bg-raised border border-line-strong rounded-md px-3 py-2">
              {pipeline.map((id, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 font-mono text-[12px]"
                >
                  {i > 0 && <span className="text-subtle/60 mx-1">→</span>}
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      background: AGENT_ACCENT[id],
                      outline: `3px solid ${AGENT_ACCENT[id]}22`,
                    }}
                  />
                  <span className="text-fg">{id}</span>
                </span>
              ))}
              <button
                type="button"
                onClick={() =>
                  setPipeline(
                    ([a, b]) => [b!, a!] as ("claude" | "codex")[],
                  )
                }
                className="ml-auto h-7 px-2.5 rounded-md text-[11.5px] text-muted hover:text-fg hover:bg-fg/5 transition-colors flex items-center gap-1 font-mono"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M2 4H9M9 4L7 2M9 4L7 6M10 8H3M3 8L5 6M3 8L5 10"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                swap
              </button>
            </div>
          </section>

          {isEdit && (
            <section>
              <SectionLabel>提示</SectionLabel>
              <p className="text-[12px] text-subtle leading-relaxed">
                改完后下一轮立即生效；正在生成的轮不会被打断。改 model
                / mode 不会重置已存在的 native session id（仍走 resume 拿
                cache），换 model 后下一轮 SDK 会按新 model 跑。
              </p>
            </section>
          )}

          {err && (
            <div className="amber-card rounded-md px-3 py-2 text-[12.5px] text-fg font-mono">
              {err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line">
          <button
            onClick={onClose}
            type="button"
            className="h-8 px-3 rounded-md text-[12.5px] text-muted hover:text-fg hover:bg-fg/5 transition-colors"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy}
            type="button"
            className="h-8 px-4 rounded-md bg-blue hover:bg-blue-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-[12.5px] font-medium tracking-tight transition-colors flex items-center gap-1.5"
          >
            {busy ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                {busyLabel}
              </>
            ) : (
              <>{submitLabel}</>
            )}
          </button>
        </div>
      </div>
      {pickingCwd && (
        <OpenProjectDialog
          onClose={() => setPickingCwd(false)}
          onOpen={(p) => {
            setGroupCwd(p);
            setPickingCwd(false);
          }}
        />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[11px] font-mono text-fg uppercase tracking-[0.1em] mb-2">
      {children}
    </h4>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-fg font-mono uppercase tracking-[0.1em]">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function ParticipantCard({
  agent,
  value,
  onChange,
  showMode,
  rolePlaceholder,
}: {
  agent: "claude" | "codex";
  value: GroupParticipant;
  onChange: (v: GroupParticipant) => void;
  showMode?: boolean;
  rolePlaceholder?: string;
}) {
  const accent = AGENT_ACCENT[agent];
  return (
    <div
      className="bg-raised border border-line-strong rounded-md p-3 space-y-1 relative"
      style={{ boxShadow: `inset 2px 0 0 ${accent}` }}
    >
      <div className="flex items-center gap-2 mb-2">
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
          {value.model}
        </span>
      </div>

      <div className="space-y-1">
        <ParamRow label="模型">
          <ModelSelector
            provider={agent}
            value={value.model}
            onChange={(model) => onChange({ ...value, model })}
            direction="down"
            align="right"
          />
        </ParamRow>
        {showMode && (
          <ParamRow label="权限模式">
            <ModeSelector
              value={(value.mode ?? "default") as PermissionMode}
              onChange={(mode) => onChange({ ...value, mode })}
              direction="down"
              align="right"
            />
          </ParamRow>
        )}
        <ParamRow label="effort">
          <EffortSelector
            value={(value.effort ?? "medium") as EffortLevel}
            model={value.model}
            onChange={(effort) => onChange({ ...value, effort })}
            direction="down"
            align="right"
          />
        </ParamRow>
      </div>

      <div className="px-1.5 pt-2">
        <span className="text-[11px] text-fg font-mono uppercase tracking-[0.1em] block mb-1.5">
          system prompt（角色设定）
        </span>
        <textarea
          value={value.systemPrompt ?? ""}
          onChange={(e) =>
            onChange({ ...value, systemPrompt: e.target.value })
          }
          rows={2}
          className="w-full bg-canvas border border-line rounded-md px-2.5 py-1.5 text-[12.5px] text-fg placeholder:text-subtle resize-none focus:outline-none focus:border-fg/25 transition-colors"
          placeholder={rolePlaceholder ?? "可选"}
        />
      </div>
    </div>
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
