export type PermissionMode =
  | "default"
  | "auto"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

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
  // 根据实际模型目录限制档位；模型不支持 max 时 clamp 到更低档。
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
  { id: "claude", label: "Claude", hint: "claude CLI" },
  { id: "codex", label: "Codex", hint: "codex CLI" },
];

export type ModelOption = {
  id: string;
  label: string;
  hint: string;
  // Pinned entries only: the family the id belongs to, which is what the
  // effort rules key on (an alias is its own family).
  family?: string;
  pinned?: boolean;
  supportedEfforts?: EffortLevel[];
  defaultEffort?: EffortLevel;
};

// Family aliases first, then a few pinned versions.
//
// The aliases are the default and the point: the `claude` CLI resolves them to
// whatever is current. Verified live 2026-09-23 on CLI 2.1.280: opus →
// claude-opus-5-5, fable → claude-fable-5-1, sonnet → claude-sonnet-5 (haiku →
// claude-haiku-4-5-20251001 as of the migration). Pinning versions here is what
// let this list rot a whole generation behind (it still said opus-4.8 /
// sonnet-4.6 after opus-5 / sonnet-5 shipped), so the alias labels carry no
// version number.
//
// The pinned entries exist because an alias moving is not always welcome: the
// day opus became 5.5 it also started thinking more per turn at the same
// effort, and the admin wanted the previous generations back as a choice. They
// are exact slugs, so unlike the aliases they WILL be retired one day and start
// returning errors. **Adding one = run a real turn on it first**
// (`echo ok | claude -p --model <id> --output-format json` and check
// `modelUsage`); these three were checked that way on 2026-09-23.
//
// Other aliases the CLI accepts, if ever wanted: `default`, `opusplan`,
// `opus[1m]`, `sonnet[1m]` (the [1m] pair being the 1M-context variants).
const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { id: "opus", label: "Opus", hint: "旗舰 · 深度推理 · 跟随最新" },
  { id: "fable", label: "Fable", hint: "Mythos 级 · 最强 · 跟随最新" },
  { id: "sonnet", label: "Sonnet", hint: "均衡 · 跟随最新" },
  { id: "haiku", label: "Haiku", hint: "快 · 便宜 · 跟随最新" },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    hint: "上一代旗舰 · 不随升级变化",
    family: "opus",
    pinned: true,
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    hint: "再上一代 · 不随升级变化",
    family: "opus",
    pinned: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    hint: "上一代 Sonnet · 不随升级变化",
    family: "sonnet",
    pinned: true,
  },
];

// Pinned ids that older saved settings / group configs may still hold and that
// are NOT offered as options, mapped forward onto the alias that supersedes
// them. Direction matters: this used to run the other way (alias → pinned id),
// which is exactly how a stored "sonnet" stopped matching any option and got
// silently rewritten to the first entry in the list.
//
// An id that is also a pinned option above must not appear here — it would
// relabel "Opus 5" as "Opus", i.e. lie about which model is running.
const CLAUDE_LEGACY_ALIAS: Record<string, string> = {
  "claude-opus-4-7": "opus",
  "claude-sonnet-5": "sonnet",
  "claude-haiku-4-5": "haiku",
  "claude-haiku-4-5-20251001": "haiku",
  "claude-fable-5": "fable",
};

export function canonicalizeClaudeModel(id: string): string {
  return CLAUDE_LEGACY_ALIAS[id] ?? id;
}

// The family a Claude model id belongs to: an alias is its own family, a pinned
// option names its family, anything else goes through the legacy map.
function claudeFamily(id: string): string {
  const option = CLAUDE_MODEL_OPTIONS.find((m) => m.id === id);
  if (option) return option.family ?? option.id;
  return canonicalizeClaudeModel(id);
}

// Runtime metadata from the service's CLI cache is authoritative. This list is
// only a conservative fallback when that file is unavailable/malformed.
export const CODEX_FALLBACK_MODELS: ModelOption[] = [
  { id: "gpt-6-sol", label: "GPT-6-Sol", hint: "日常编码与 agent 主力" },
  { id: "gpt-6-astra", label: "GPT-6-Astra", hint: "复杂任务与深入推理" },
  { id: "gpt-6-luna", label: "GPT-6-Luna", hint: "更快 · 轻量任务" },
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", hint: "上一代编码主力" },
  { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", hint: "上一代均衡模型" },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", hint: "上一代轻量模型" },
  { id: "gpt-5.5", label: "GPT-5.5", hint: "旧版本" },
].map(m => ({ ...m, supportedEfforts: ["low", "medium", "high", "xhigh"] as EffortLevel[] }));
let CODEX_MODEL_OPTIONS = CODEX_FALLBACK_MODELS;
let catalogVersion = 0;
let catalogSource: "cli-cache" | "fallback" = "fallback";
export const codexCatalogSource = () => catalogSource;
const catalogListeners = new Set<() => void>();
export const modelCatalogVersion = () => catalogVersion;
export const subscribeModelCatalog = (listener: () => void) => {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
};
export function defaultCodexModel(models: ModelOption[]): string {
  return models.find(m => m.id === "gpt-6-sol")?.id ?? models.find(m => m.id === "gpt-5.6-sol")?.id ?? models[0]?.id ?? "gpt-6-sol";
}

// Parse only public model metadata, never cache identity/account/token fields.
export function parseCodexModelsCache(raw: unknown): ModelOption[] | null {
  if (!raw || typeof raw !== "object" || !("models" in raw) || !Array.isArray(raw.models)) return null;
  const seen = new Set<string>();
  const models = raw.models.slice(0, 200).flatMap((m: any, index: number) => {
    if (!m || m.visibility !== "list" || typeof m.slug !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(m.slug) || seen.has(m.slug)) return [];
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const supported = EFFORT_OPTIONS.map(o => o.id).filter(effort => levels.some((l: any) => l?.effort === effort));
    if (!supported.length) return [];
    seen.add(m.slug);
    const model: ModelOption = {
      id: m.slug,
      label: typeof m.display_name === "string" ? m.display_name.slice(0, 100) : m.slug,
      hint: typeof m.description === "string" ? m.description.slice(0, 256) : "Codex CLI 模型",
      supportedEfforts: supported,
      ...(supported.includes(m.default_reasoning_level) ? { defaultEffort: m.default_reasoning_level } : {}),
    };
    return [{ model, order: Number.isFinite(m.priority) ? m.priority : index + 1000 }];
  }).sort((a, b) => a.order - b.order).map(m => m.model);
  return models.length ? models : null;
}
export function configureCodexModels(raw: unknown, source: "cli-cache" | "fallback" = "cli-cache"): boolean {
  if (!Array.isArray(raw)) return false;
  const models = parseCodexModelsCache({ models: raw.map(m => ({
    slug: m?.id, display_name: m?.label, description: m?.hint, visibility: "list",
    supported_reasoning_levels: Array.isArray(m?.supportedEfforts) ? m.supportedEfforts.map((effort: unknown) => ({ effort })) : [],
    default_reasoning_level: m?.defaultEffort,
  })) });
  if (!models) return false;
  if (source !== catalogSource || JSON.stringify(models) !== JSON.stringify(CODEX_MODEL_OPTIONS)) {
    CODEX_MODEL_OPTIONS = models; catalogSource = source; catalogVersion++;
    for (const listener of catalogListeners) listener();
  }
  return true;
}

export const MODEL_OPTIONS = CLAUDE_MODEL_OPTIONS;

export function providerLabel(id: AgentProvider): string {
  return PROVIDER_OPTIONS.find((p) => p.id === id)?.label ?? id;
}

export function modelOptionsForProvider(provider: AgentProvider) {
  return provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
}

export function defaultModelForProvider(provider: AgentProvider): string {
  return provider === "codex" ? defaultCodexModel(CODEX_MODEL_OPTIONS) : DEFAULT_SETTINGS.model;
}

export const MODE_OPTIONS: Array<{
  id: PermissionMode;
  label: string;
  hint: string;
  // 决策 12：普通账号不给 bypass。它不是「少弹几张卡」——bypass 下 CLI 根本不调
  // canUseTool，权限卡和 auto 的安全分类器一起消失，等于把 shell 直接交出去。
  // 这里只管不显示，真正拦住的是 server/chat.ts（body 是客户端说了算的）。
  adminOnly?: boolean;
}> = [
  { id: "default", label: "Default", hint: "每次弹权限" },
  { id: "auto", label: "Auto", hint: "模型判断，仅存疑时才问" },
  { id: "acceptEdits", label: "Accept Edits", hint: "自动批 Edit/Write" },
  { id: "plan", label: "Plan", hint: "只规划不执行" },
  { id: "bypassPermissions", label: "Bypass", hint: "全部放行（危险）", adminOnly: true },
];

export function modeOptionsFor(isAdmin: boolean) {
  return isAdmin ? MODE_OPTIONS : MODE_OPTIONS.filter((m) => !m.adminOnly);
}

// 存量 localStorage 里可能留着一个现在不许用的 mode（管理员被降级、或换了账号
// 登录同一个浏览器）。留着它的话每次发送都会被服务端 403，而设置面板上还显示得
// 好好的——所以读设置时就落回 default。
export function legalModeFor(mode: PermissionMode, isAdmin: boolean): PermissionMode {
  return modeOptionsFor(isAdmin).some((m) => m.id === mode) ? mode : "default";
}

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
  // Extra Codex tiers are shown only when the CLI model metadata supports them.
  codexOnly?: boolean;
}> = [
  { id: "none", label: "None", hint: "不使用推理", codexOnly: true },
  { id: "minimal", label: "Minimal", hint: "最少推理", codexOnly: true },
  { id: "low", label: "Low", hint: "较少推理 · 更快" },
  { id: "medium", label: "Medium", hint: "均衡（默认）" },
  { id: "high", label: "High", hint: "更深入的推理" },
  { id: "xhigh", label: "xHigh", hint: "长时间思考", xhighTier: true },
  {
    id: "max",
    label: "Max",
    hint: "最大限度 · 最慢",
  },
  { id: "ultra", label: "Ultra", hint: "最深入推理 · 可自动委派", codexOnly: true },
];

function isCodexModel(model: string): boolean {
  return CODEX_MODEL_OPTIONS.some((m) => m.id === model) || /^(?:gpt-|codex-|o\d)/.test(model);
}

// Which Claude families expose the xhigh effort tier. Hand-maintained on
// purpose: the CLI validates `--effort` not at all — `haiku --effort xhigh` and
// even `--effort bogustier` are accepted silently — so it cannot be the judge.
// Keyed by family, so neither a new version nor a pinned entry needs an edit
// here (Opus 4.8 / 5 have xhigh; Sonnet 4.6 does not — xhigh arrived with
// Opus 4.7).
const XHIGH_CLAUDE_MODELS = new Set(["opus", "fable"]);

export function supportsXhighEffort(model: string): boolean {
  if (XHIGH_CLAUDE_MODELS.has(claudeFamily(model))) return true;
  return isCodexModel(model);
}

// Clamp an effort to what this model actually offers, preferring the closest
// tier below. The supported Codex tiers come from the runtime model metadata.
export function clampEffort(effort: EffortLevel, model: string): EffortLevel {
  const available = availableEffortOptions(model).map((o) => o.id);
  if (available.includes(effort)) return effort;
  const order = EFFORT_OPTIONS.map((o) => o.id);
  for (let i = order.indexOf(effort) - 1; i >= 0; i--) {
    if (available.includes(order[i])) return order[i];
  }
  return available[0] ?? "medium";
}

export function availableEffortOptions(model: string, codexModels = CODEX_MODEL_OPTIONS) {
  if (isCodexModel(model) || codexModels.some(m => m.id === model)) {
    const supported = codexModels.find(m => m.id === model)?.supportedEfforts ?? ["low", "medium", "high", "xhigh"];
    return EFFORT_OPTIONS.filter(o => supported.includes(o.id));
  }
  const family = claudeFamily(model);
  return EFFORT_OPTIONS.filter(o => !o.codexOnly && (!o.xhighTier || XHIGH_CLAUDE_MODELS.has(family)));
}

export function effortLabel(id: EffortLevel): string {
  return EFFORT_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export function displayCwd(v: string): string {
  if (!v) return "cwd: default";
  return v;
}
