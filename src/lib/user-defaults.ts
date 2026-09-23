// 管理员给账号设的默认模型 / effort（docs/user-permissions.md 决策 45-47）。
//
// ⚠️ 是**默认值不是限制**：用户在输入框里照样能改，服务端也不拿它覆盖请求。
// 所以「什么时候套用」就是这个功能的全部：
//
// · 每次加载都套用 → 用户自己改的，刷新一下就被冲掉了，等于变相锁死。
// · 只在第一次套用 → 管理员之后再改，这台浏览器永远看不到。
//
// 于是记下「这台浏览器上、这个账号、最后套用过的是哪一版」（服务端的
// updatedAt），版本变了才套用一次。管理员每保存一次版本就变一次，所以「重新保存
// 同样的值」也会再推一遍 —— 那正是管理员想把对方拉回默认值时会做的事。

import {
  EFFORT_OPTIONS,
  clampEffort,
  modelOptionsForProvider,
  type EffortLevel,
  type Settings,
} from "./settings";

export type UserDefaults = {
  model: string | null;
  effort: EffortLevel | null;
  updatedAt: number;
};

// userId → 最后套用过的 updatedAt。按账号分开记，因为同一个浏览器会换人登录。
export type AppliedMarks = Record<string, number>;

const APPLIED_KEY = "cc-webui:defaults-applied";

export function loadAppliedMarks(): AppliedMarks {
  try {
    const raw = localStorage.getItem(APPLIED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as AppliedMarks) : {};
  } catch {
    return {};
  }
}

export function saveAppliedMarks(marks: AppliedMarks): void {
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify(marks));
  } catch {
    /* quota or private mode：最坏是下次加载再套用一遍，不丢东西 */
  }
}

// 比的是「不相等」而不是「更新」：服务端的版本号保证只增，这里只需要知道
// 「是不是套用过这一版」。
export function hasPendingDefaults(
  defaults: UserDefaults | null | undefined,
  userId: string,
  marks: AppliedMarks,
): defaults is UserDefaults {
  return !!defaults && marks[userId] !== defaults.updatedAt;
}

export function applyUserDefaults(s: Settings, d: UserDefaults): Settings {
  // 模型只对 Claude 生效：默认值来自 Claude 的模型表，而 Codex 只有管理员能用，
  // 塞一个 Claude 模型给 Codex 会话只会让下一次发送失败。
  // 选项表里已经没有的 id（某个固定版本下线了）直接忽略，别把人卡在一个发不出去的模型上。
  const model =
    d.model &&
    s.agentProvider === "claude" &&
    modelOptionsForProvider("claude").some((o) => o.id === d.model)
      ? d.model
      : s.model;
  const wanted =
    d.effort && EFFORT_OPTIONS.some((o) => o.id === d.effort) ? d.effort : s.effort;
  // 和输入框里换模型是同一条规则：新模型没有这一档（Sonnet 没有 xHigh）就往下落。
  return { ...s, model, effort: clampEffort(wanted, model) };
}
