// 钉住每账号 skill / plugin 隔离（docs/desktop-client.md 决策 20）。
//
// ⚠️ 这个模块修的是一个**当前就存在**的问题：CLI 以服务进程那个 OS 用户的身份跑，
// 家人的每个 turn 都会全量加载 owner 的 ~/.claude 插件。所以这里最重要的断言是
// **settingSources 恒为 ["project","local"]** —— 少了它，--plugin-dir 只是叠加，
// 隔离完全不成立（2026-08-30 用三次真实 CLI 调用实测过，见被测文件的头注释）。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-plugins-"));
process.env.CC_WEBUI_PLUGINS_DIR = tmp;

const { accountPluginDir, accountPlugins, accountPluginsRoot } = await import(
  "./account-plugins.ts"
);

try {
  // ── 目录根按 env 走，且是在函数体里读的 ──────────────────────────────────
  assert.equal(accountPluginsRoot(), tmp);
  assert.equal(accountPlugins("nobody").pluginDirs.length, 0, "目录不存在 = 没有额外插件，不是错误");
  assert.deepEqual(
    accountPlugins("nobody").settingSources,
    ["project", "local"],
    "⭐ 即使一个插件都没有，也必须排掉 user 级 —— 否则 owner 的个人插件照样漏进来",
  );

  // ── 只认真正的插件目录（含 .claude-plugin/plugin.json）────────────────────
  const dir = accountPluginDir("alice");
  await fs.mkdir(path.join(dir, "real", ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "real", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "real", version: "0.0.1" }),
  );
  // 一个长得像但缺清单的目录 —— 传给 --plugin-dir 只会让 CLI 报一个和真因无关的错。
  await fs.mkdir(path.join(dir, "not-a-plugin"), { recursive: true });
  // 一个散落的文件，不该被当成插件。
  await fs.writeFile(path.join(dir, "README.txt"), "hi");

  const alice = accountPlugins("alice");
  assert.deepEqual(
    alice.pluginDirs.map((d) => path.basename(d)),
    ["real"],
    "只有带 .claude-plugin/plugin.json 的子目录算数",
  );
  assert.deepEqual(alice.settingSources, ["project", "local"]);

  // ── 账号之间互不可见 ─────────────────────────────────────────────────────
  assert.equal(
    accountPlugins("bob").pluginDirs.length,
    0,
    "bob 不该看到 alice 的插件",
  );

  // ── username 缺失 = 不做隔离 ─────────────────────────────────────────────
  // 拿不到登录账号时没有「哪个账号」可言，擅自剥掉 user 级设置会让 owner 自己的
  // turn 莫名其妙少东西。真正的收口在别处（起 turn 的路由都是 auth:"user"）。
  assert.deepEqual(accountPlugins(undefined), {
    pluginDirs: [],
    settingSources: [],
  });

  // ── 总闸 ─────────────────────────────────────────────────────────────────
  for (const off of ["0", "false", "off", "no", "OFF"]) {
    process.env.CC_WEBUI_ACCOUNT_PLUGINS = off;
    assert.deepEqual(
      accountPlugins("alice"),
      { pluginDirs: [], settingSources: [] },
      `CC_WEBUI_ACCOUNT_PLUGINS=${off} 应当整套关掉（含 settingSources）`,
    );
  }
  process.env.CC_WEBUI_ACCOUNT_PLUGINS = "1";
  assert.equal(accountPlugins("alice").pluginDirs.length, 1, "1 = 开着");
  delete process.env.CC_WEBUI_ACCOUNT_PLUGINS;
  assert.equal(accountPlugins("alice").pluginDirs.length, 1, "不设 = 默认开着");

  console.log("account-plugins.test.ts: all assertions passed");
} finally {
  delete process.env.CC_WEBUI_PLUGINS_DIR;
  delete process.env.CC_WEBUI_ACCOUNT_PLUGINS;
  await fs.rm(tmp, { recursive: true, force: true });
}
