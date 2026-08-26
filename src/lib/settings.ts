export type PermissionMode =
  | "default"
  | "auto"
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
  // Absent = follow the OS. Only written once the user actually flips the
  // toggle, which is what `themeChosen` records — an old stored "dark" is
  // indistinguishable from the old hardcoded default, so it is ignored.
  theme?: Theme;
  themeChosen?: boolean;
};

const KEY = "cc-webui:settings";
const RECENTS_KEY = "cc-webui:cwd-recents";

export const DEFAULT_SETTINGS: Settings = {
  cwd: "",
  agentProvider: "claude",
  model: "opus",
  // auto = 模型自己的行为分类器决定要不要问（决策 12 保留了它，禁掉的是 bypass）。
  permissionMode: "auto",
  // max 是 Claude 独有的顶档；切到 Codex 时 modelOptionsForProvider/EFFORT_OPTIONS
  // 会把它过滤掉，落回 xhigh。
  effort: "max",
};

export function systemTheme(): Theme {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings;
    // Every earlier build persisted theme:"dark" on first render whether or not
    // anyone asked for it, so a stored theme without themeChosen carries no
    // intent — drop it and fall back to the OS.
    if (!parsed.themeChosen) delete parsed.theme;
    return parsed;
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

// Family aliases, NOT pinned version ids.
//
// The `claude` CLI resolves these server-side to whatever is current — verified
// live: opus → claude-opus-5, fable → claude-fable-5, sonnet → claude-sonnet-5,
// haiku → claude-haiku-4-5-20251001. Pinning versions here is what let this
// list rot a whole generation behind (it still said opus-4.8 / sonnet-4.6 after
// opus-5 / sonnet-5 shipped), so the labels deliberately carry no version
// number either.
//
// Other aliases the CLI accepts, if ever wanted: `default`, `opusplan`,
// `opus[1m]`, `sonnet[1m]` (the [1m] pair being the 1M-context variants).
const CLAUDE_MODEL_OPTIONS: Array<{ id: string; label: string; hint: string }> =
  [
    { id: "opus", label: "Opus", hint: "旗舰 · 深度推理 · 跟随最新" },
    { id: "fable", label: "Fable", hint: "Mythos 级 · 最强 · 跟随最新" },
    { id: "sonnet", label: "Sonnet", hint: "均衡 · 跟随最新" },
    { id: "haiku", label: "Haiku", hint: "快 · 便宜 · 跟随最新" },
  ];

// Pinned ids that older saved settings / group configs may still hold, mapped
// forward onto the alias that supersedes them. Direction matters: this used to
// run the other way (alias → pinned id), which is exactly how a stored "sonnet"
// stopped matching any option and got silently rewritten to the first entry in
// the list.
const CLAUDE_LEGACY_ALIAS: Record<string, string> = {
  "claude-opus-4-7": "opus",
  "claude-opus-4-8": "opus",
  "claude-opus-5": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-5": "sonnet",
  "claude-haiku-4-5": "haiku",
  "claude-haiku-4-5-20251001": "haiku",
  "claude-fable-5": "fable",
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
  { id: "auto", label: "Auto", hint: "模型判断，仅存疑时才问" },
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

// Which Claude families expose the xhigh effort tier. Hand-maintained on
// purpose: the CLI validates `--effort` not at all — `haiku --effort xhigh` and
// even `--effort bogustier` are accepted silently — so it cannot be the judge.
// Aliases now, so this no longer needs editing when a version ships.
const XHIGH_CLAUDE_MODELS = new Set(["opus", "fable"]);

export function supportsXhighEffort(model: string): boolean {
  const canonical = canonicalizeClaudeModel(model);
  if (XHIGH_CLAUDE_MODELS.has(canonical)) return true;
  return isCodexModel(model);
}

// Clamp an effort to what this model actually offers, preferring the closest
// tier below. Needed now that the DEFAULT is `max`: that tier is Claude-only,
// so switching to Codex (or to Sonnet/Haiku, which lack xhigh too) would
// otherwise carry an effort the target does not have.
export function clampEffort(effort: EffortLevel, model: string): EffortLevel {
  const available = availableEffortOptions(model).map((o) => o.id);
  if (available.includes(effort)) return effort;
  const order = EFFORT_OPTIONS.map((o) => o.id);
  for (let i = order.indexOf(effort) - 1; i >= 0; i--) {
    if (available.includes(order[i])) return order[i];
  }
  return available[0] ?? "medium";
}

export function availableEffortOptions(model: string) {
  const codex = isCodexModel(model);
  const canonical = canonicalizeClaudeModel(model);
  return EFFORT_OPTIONS.filter((o) => {
    // xhigh: only top-tier Claude (Opus/Fable) + Codex models
    if (o.xhighTier && !XHIGH_CLAUDE_MODELS.has(canonical) && !codex) {
      return false;
    }
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
