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

// ⚠️ Codex has **no family aliases** — an exact slug or a 400. So unlike the
// Claude list above, this one cannot follow the CLI on its own and WILL go
// stale. It went stale once already: on 2026-09-17 four of the five entries
// here (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`) were measured
// returning `The '<id>' model is not supported when using Codex with a ChatGPT
// account.` — i.e. the picker offered one working model out of five.
//
// The list below is every model with `visibility: "list"` in
// `~/.codex/models_cache.json` (client_version 0.144.1), each one verified with
// a real turn. **When you touch this list, verify the same way** — the CLI
// cannot enumerate models (`codex models` → "stdin is not a terminal") and it
// does not validate `--model` client-side either.
//
// Reading that cache at runtime is decision #9 in docs/cli-migration.md and is
// still the right end state; it needs a server route + a fallback, because the
// file is a server-fetched cache that is sometimes corrupt (it was, during the
// migration research) and its schema is Codex-internal.
const CODEX_MODEL_OPTIONS: ModelOption[] =
  [
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", hint: "日常 agent 主力" },
    { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", hint: "均衡 · 编码日常" },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", hint: "快 · 便宜" },
    { id: "gpt-5.5", label: "GPT-5.5", hint: "上一代 · 编码与通用" },
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
// Keyed by family, so neither a new version nor a pinned entry needs an edit
// here (Opus 4.8 / 5 have xhigh; Sonnet 4.6 does not — xhigh arrived with
// Opus 4.7).
const XHIGH_CLAUDE_MODELS = new Set(["opus", "fable"]);

export function supportsXhighEffort(model: string): boolean {
  if (XHIGH_CLAUDE_MODELS.has(claudeFamily(model))) return true;
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
  const family = claudeFamily(model);
  return EFFORT_OPTIONS.filter((o) => {
    // xhigh: only top-tier Claude (Opus/Fable) + Codex models
    if (o.xhighTier && !XHIGH_CLAUDE_MODELS.has(family) && !codex) {
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
