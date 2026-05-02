export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type AgentProvider = "claude" | "codex";

export type Theme = "light" | "dark";

export type Settings = {
  cwd: string;
  agentProvider: AgentProvider;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  theme: Theme;
};

const KEY = "cc-webui:settings";
const RECENTS_KEY = "cc-webui:cwd-recents";

export const DEFAULT_SETTINGS: Settings = {
  cwd: "",
  agentProvider: "claude",
  model: "sonnet",
  permissionMode: "acceptEdits",
  effort: "medium",
  theme: "dark",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota or private mode */
  }
}

export function loadCwdRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function pushCwdRecent(value: string) {
  if (!value) return;
  const cur = loadCwdRecents().filter((x) => x !== value);
  const next = [value, ...cur].slice(0, 6);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export const PROVIDER_OPTIONS: Array<{
  id: AgentProvider;
  label: string;
  hint: string;
}> = [
  { id: "claude", label: "Claude", hint: "Claude Code SDK" },
  { id: "codex", label: "Codex", hint: "Codex SDK" },
];

const CLAUDE_MODEL_OPTIONS: Array<{ id: string; label: string; hint: string }> =
  [
    { id: "claude-opus-4-7", label: "claude-opus-4-7", hint: "Opus 4.7 · 最强 · 较慢" },
    { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", hint: "Sonnet 4.6 · 均衡" },
    { id: "claude-haiku-4-5", label: "claude-haiku-4-5", hint: "Haiku 4.5 · 快 · 便宜" },
  ];

// Legacy short aliases used in older saved data ("opus" → "claude-opus-4-7"),
// kept so dropdown / label rendering doesn't show raw "opus" in places that
// were saved before this rename. The Claude SDK accepts both forms; we
// surface the canonical full name everywhere in the UI now.
const CLAUDE_LEGACY_ALIAS: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

export function canonicalizeClaudeModel(id: string): string {
  return CLAUDE_LEGACY_ALIAS[id] ?? id;
}

const CODEX_MODEL_OPTIONS: Array<{ id: string; label: string; hint: string }> =
  [
    { id: "gpt-5.5", label: "GPT-5.5", hint: "前沿 · 复杂编码与研究" },
    { id: "gpt-5.4", label: "GPT-5.4", hint: "日常编码主力" },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 mini",
      hint: "快 · 便宜 · 简单任务",
    },
    { id: "gpt-5.3-codex", label: "GPT-5.3-Codex", hint: "Coding 优化" },
    { id: "gpt-5.2", label: "GPT-5.2", hint: "长时任务 · 专业工作" },
  ];

export const MODEL_OPTIONS = CLAUDE_MODEL_OPTIONS;

export function providerLabel(id: AgentProvider): string {
  return PROVIDER_OPTIONS.find((p) => p.id === id)?.label ?? id;
}

export function modelOptionsForProvider(provider: AgentProvider) {
  return provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
}

export function defaultModelForProvider(provider: AgentProvider): string {
  return modelOptionsForProvider(provider)[0]?.id ?? DEFAULT_SETTINGS.model;
}

export const MODE_OPTIONS: Array<{
  id: PermissionMode;
  label: string;
  hint: string;
}> = [
  { id: "default", label: "Default", hint: "每次弹权限" },
  { id: "acceptEdits", label: "Accept Edits", hint: "自动批 Edit/Write" },
  { id: "plan", label: "Plan", hint: "只规划不执行" },
  { id: "bypassPermissions", label: "Bypass", hint: "全部放行（危险）" },
];

export function modelLabel(id: string): string {
  const canonical = canonicalizeClaudeModel(id);
  return (
    CLAUDE_MODEL_OPTIONS.find((m) => m.id === canonical)?.label ??
    CODEX_MODEL_OPTIONS.find((m) => m.id === canonical)?.label ??
    id
  );
}

export function modeLabel(id: PermissionMode): string {
  return MODE_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export const EFFORT_OPTIONS: Array<{
  id: EffortLevel;
  label: string;
  hint: string;
  // Tier only available on Claude Opus / Codex (not Sonnet/Haiku).
  xhighTier?: boolean;
  // `max` is a Claude-only label; the Codex SDK's top tier is xhigh,
  // so we hide max in Codex UI to avoid implying a real tier above xhigh.
  claudeOnly?: boolean;
}> = [
  { id: "low", label: "Low", hint: "几乎不思考 · 最快" },
  { id: "medium", label: "Medium", hint: "均衡（默认）" },
  { id: "high", label: "High", hint: "更深入的推理" },
  { id: "xhigh", label: "xHigh", hint: "长时间思考", xhighTier: true },
  {
    id: "max",
    label: "Max",
    hint: "最大限度 · 最慢",
    claudeOnly: true,
  },
];

function isCodexModel(model: string): boolean {
  return CODEX_MODEL_OPTIONS.some((m) => m.id === model);
}

export function supportsXhighEffort(model: string): boolean {
  const canonical = canonicalizeClaudeModel(model);
  if (canonical === "claude-opus-4-7") return true;
  return isCodexModel(model);
}

export function availableEffortOptions(model: string) {
  const codex = isCodexModel(model);
  const canonical = canonicalizeClaudeModel(model);
  return EFFORT_OPTIONS.filter((o) => {
    // xhigh: only Opus + Codex models
    if (o.xhighTier && canonical !== "claude-opus-4-7" && !codex) return false;
    // max: Claude-only (Codex's top tier IS xhigh)
    if (o.claudeOnly && codex) return false;
    return true;
  });
}

export function effortLabel(id: EffortLevel): string {
  return EFFORT_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export function displayCwd(v: string): string {
  if (!v) return "cwd: default";
  return v;
}
