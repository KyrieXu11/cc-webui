// 管理员设的默认模型 / effort，浏览器那一半：什么时候套用、套用成什么。
// 服务端那一半（校验、存储、下发）在 server/admin-defaults.test.ts。
//
// 这个功能是「默认值，不是限制」，所以「什么时候套用」就是它的全部 ——
// 每次加载都套用，等于把用户自己的选择锁死；只套用一次，管理员之后改了又看不到。

import assert from "node:assert/strict";
import {
  applyUserDefaults,
  hasPendingDefaults,
  type UserDefaults,
} from "./user-defaults.ts";
import {
  DEFAULT_SETTINGS,
  availableEffortOptions,
  modelLabel,
  type EffortLevel,
  type Settings,
} from "./settings.ts";

const base: Settings = { ...DEFAULT_SETTINGS, model: "opus", effort: "max" };
const d = (over: Partial<UserDefaults>): UserDefaults => ({
  model: null,
  effort: null,
  updatedAt: 1,
  ...over,
});

// ── 什么时候套用 ─────────────────────────────────────────────────────────────

assert.equal(hasPendingDefaults(null, "u1", {}), false, "没设就什么都不做");
assert.equal(
  hasPendingDefaults(d({ effort: "medium" }), "u1", {}),
  true,
  "这台浏览器还没套用过",
);
assert.equal(
  hasPendingDefaults(d({ effort: "medium", updatedAt: 5 }), "u1", { u1: 5 }),
  false,
  "套用过这一版就不再套用 —— 否则用户自己改的，一刷新就被冲掉",
);
assert.equal(
  hasPendingDefaults(d({ updatedAt: 6 }), "u1", { u1: 5 }),
  true,
  "管理员又保存了一次",
);
assert.equal(
  hasPendingDefaults(d({ updatedAt: 5 }), "u2", { u1: 5 }),
  true,
  "按账号分开记：同一个浏览器会换人登录",
);

// ── 套用成什么 ───────────────────────────────────────────────────────────────

let s = applyUserDefaults(base, d({ model: "claude-opus-5", effort: "medium" }));
assert.equal(s.model, "claude-opus-5");
assert.equal(s.effort, "medium");

s = applyUserDefaults(base, d({ effort: "high" }));
assert.equal(s.model, "opus", "只设 effort 不动模型");
assert.equal(s.effort, "high");

s = applyUserDefaults({ ...base, effort: "xhigh" }, d({ model: "claude-sonnet-4-6" }));
assert.equal(s.model, "claude-sonnet-4-6");
assert.equal(s.effort, "high", "只设模型时，手上的 effort 按新模型往下落（Sonnet 4.6 没有 xHigh）");

s = applyUserDefaults(
  { ...base, agentProvider: "codex", model: "gpt-5.5", effort: "xhigh" },
  d({ model: "claude-opus-5", effort: "medium" }),
);
assert.equal(s.model, "gpt-5.5", "Codex 会话不塞 Claude 模型，否则下一次发送必失败");
assert.equal(s.effort, "medium");

s = applyUserDefaults(base, d({ model: "claude-opus-3" }));
assert.equal(s.model, "opus", "选项表里已经没有的固定版本直接忽略");

s = applyUserDefaults(base, d({ effort: "bogus" as EffortLevel }));
assert.equal(s.effort, "max", "不认识的 effort 不能被 clamp 成 low");

// ── 新加的三个固定版本 ───────────────────────────────────────────────────────

const has = (model: string, effort: EffortLevel) =>
  availableEffortOptions(model).some((o) => o.id === effort);
assert.ok(has("claude-opus-5", "xhigh"), "Opus 5 有 xHigh");
assert.ok(has("claude-opus-4-8", "xhigh"), "Opus 4.8 有 xHigh");
assert.ok(!has("claude-sonnet-4-6", "xhigh"), "Sonnet 4.6 没有 xHigh（它是 4.7 才有的）");
assert.ok(has("claude-sonnet-4-6", "max"));

assert.equal(
  modelLabel("claude-opus-5"),
  "Opus 5",
  "固定版本必须显示成它自己 —— 旧的映射会把它改写成「Opus」，也就是谎报正在跑的模型",
);
assert.equal(modelLabel("claude-opus-4-8"), "Opus 4.8");
assert.equal(modelLabel("claude-opus-4-7"), "Opus", "不在选项里的旧 id 仍然映射到别名");
