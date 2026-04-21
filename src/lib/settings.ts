export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type Theme = "light" | "dark";

export type Settings = {
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  theme: Theme;
};

const KEY = "cc-webui:settings";
const RECENTS_KEY = "cc-webui:cwd-recents";

export const DEFAULT_SETTINGS: Settings = {
  cwd: "",
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

export const MODEL_OPTIONS: Array<{ id: string; label: string; hint: string }> =
  [
    { id: "opus", label: "Opus 4.7", hint: "最强 · 较慢" },
    { id: "sonnet", label: "Sonnet 4.6", hint: "均衡" },
    { id: "haiku", label: "Haiku 4.5", hint: "快 · 便宜" },
  ];

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
  return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export function modeLabel(id: PermissionMode): string {
  return MODE_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export const EFFORT_OPTIONS: Array<{
  id: EffortLevel;
  label: string;
  hint: string;
}> = [
  { id: "low", label: "Low", hint: "几乎不思考 · 最快" },
  { id: "medium", label: "Medium", hint: "均衡（默认）" },
  { id: "high", label: "High", hint: "更深入的推理" },
  { id: "xhigh", label: "xHigh", hint: "长时间思考" },
  { id: "max", label: "Max", hint: "最大限度 · 最慢" },
];

export function effortLabel(id: EffortLevel): string {
  return EFFORT_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export function displayCwd(v: string): string {
  if (!v) return "cwd: default";
  return v;
}
