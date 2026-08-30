// 每账号一套 skill / plugin（docs/desktop-client.md 决策 20）。
//
// ⚠️ 它修的是一个**当前就存在**的问题，不是为桌面客户端新加的：CLI 以服务进程
// 那个 OS 用户的身份跑，所以家人的每一个 turn 都会全量加载 owner 的
// `~/.claude` 插件和 skill。`--strict-mcp-config` 只挡 MCP，**不挡 skill**。
//
// 实测（2026-08-30，CLI 2.1.250，三次真实调用对比）：
//   A 默认                                   → owner 的全部个人插件都在
//   B 只加 --plugin-dir                      → 注入的那个出现了，但是**叠加**，隔离不了
//   C --setting-sources project,local + B    → owner 的个人插件全部消失，只剩内置 + 注入
// 所以必须两个 flag 一起上，缺一个都白做。
//
// ⚠️ 这是一次**行为变化**：owner 自己在 cc-webui 里的 turn 也会失去个人插件。
// 想拿回来，往自己账号的目录里做软链即可：
//     mkdir -p ~/.cc-webui/plugins/<你的用户名>
//     ln -s ~/.claude/plugins/cache/<某插件> ~/.cc-webui/plugins/<你的用户名>/
// 整套关掉：CC_WEBUI_ACCOUNT_PLUGINS=0
//
// ⚠️ `--plugin-dir` 吃的是**一个插件**的目录（里面要有 .claude-plugin/plugin.json），
// 不是「一堆插件的父目录」。所以这里扫一层子目录，每个合格的子目录发一个 flag。

import { readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 关掉整套隔离时的取值。见文件头的行为变化说明。 */
function enabled(): boolean {
  const raw = process.env.CC_WEBUI_ACCOUNT_PLUGINS?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

// ⚠️ env 在函数体里读，绝不在模块顶层：index.ts 的 loadDotEnvOnce() 在所有
// import 求值**之后**才跑（features.ts / office.ts 同款形状）。
export function accountPluginsRoot(): string {
  return (
    process.env.CC_WEBUI_PLUGINS_DIR?.trim() ||
    path.join(os.homedir(), ".cc-webui", "plugins")
  );
}

export function accountPluginDir(username: string): string {
  return path.join(accountPluginsRoot(), username);
}

export type AccountPlugins = {
  /** 每个元素发一个 `--plugin-dir`。 */
  pluginDirs: string[];
  /**
   * 发给 `--setting-sources`（逗号 join 由 executor 负责）。
   * 空数组 = 不发这个 flag = CLI 的默认行为（user,project,local 都加载）。
   */
  settingSources: string[];
};

/**
 * 某账号这个 turn 该用哪套 skill / plugin。
 *
 * username 缺失（拿不到登录账号）时**不做隔离**：那种情况下没有「哪个账号」可言，
 * 而擅自剥掉 user 级设置会让 owner 自己的 turn 莫名其妙少东西。
 * 这不是安全豁免 —— 真正的收口在别处（起 turn 的路由都是 auth:"user"）。
 */
export function accountPlugins(username: string | undefined): AccountPlugins {
  if (!username || !enabled()) return { pluginDirs: [], settingSources: [] };

  const dir = accountPluginDir(username);
  const dirs: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = path.join(dir, entry.name);
      // 只认真正的插件目录。不合格的子目录静默跳过会让「我明明放进去了」查不动，
      // 但每个 turn 打一行日志更吵 —— 折中：只在目录存在却一个插件都没有时提示。
      if (existsSync(path.join(candidate, ".claude-plugin", "plugin.json"))) {
        dirs.push(candidate);
      }
    }
  } catch {
    // 目录不存在是**正常状态**（这个账号没有额外插件），不是错误。
  }

  return {
    pluginDirs: dirs,
    // 见文件头实测 C：只有排掉 user 级，owner 的个人插件才不会漏进来。
    settingSources: ["project", "local"],
  };
}
