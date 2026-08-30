// 客户端自己的一点点持久状态。**故意极简** —— 真正的配置（要起哪些 MCP server）
// 是服务端下发的（决策 16），这里只存那些服务端不可能知道的东西。
//
// ⚠️ 不 import electron：主进程会把 userData 目录传进来。这样这个模块能被测，
// 而且「配置文件放哪」这个决定留在主进程一处。

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type DesktopConfig = {
  /**
   * 首次启动生成，之后不变。**不参与鉴权**（鉴权是 cookie）—— 它只用来让日志和
   * 服务端 UI 能区分「还是那台机器」和「换了一台」。
   */
  deviceId: string;
  /** 给人看的名字，默认机器名。 */
  label: string;
  /** cc-webui 的地址，形如 https://cc-webui.example.com:8443 */
  serverUrl: string;
  /** 托盘里的开机自启开关（决策 25）。 */
  autoLaunch: boolean;
};

const DEFAULT_SERVER = "https://cc-webui.freeaitech.top:8443";

export function loadConfig(userDataDir: string): DesktopConfig {
  const file = path.join(userDataDir, "config.json");
  let stored: Partial<DesktopConfig> = {};
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, "utf8")) as Partial<DesktopConfig>;
    } catch (err) {
      // 配置坏了不该让客户端起不来 —— 用默认值继续，但要留下线索，
      // 否则「我的设置怎么没了」永远查不到。
      console.warn(`[config] ${file} 读不了，用默认值：${(err as Error).message}`);
    }
  }

  const cfg: DesktopConfig = {
    deviceId: stored.deviceId || randomUUID(),
    label: stored.label || os.hostname(),
    serverUrl: (stored.serverUrl || process.env.CC_WEBUI_URL || DEFAULT_SERVER)
      .trim()
      .replace(/\/+$/, ""),
    autoLaunch: stored.autoLaunch ?? true,
  };
  // deviceId 是首次生成的，立刻落盘 —— 不写的话每次启动都换一个新的，
  // 服务端日志里会看起来像家人每天换一台电脑。
  if (stored.deviceId !== cfg.deviceId) saveConfig(userDataDir, cfg);
  return cfg;
}

export function saveConfig(userDataDir: string, cfg: DesktopConfig): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    path.join(userDataDir, "config.json"),
    JSON.stringify(cfg, null, 2),
    "utf8",
  );
}

/**
 * 浏览器 profile 的位置（决策 24）。
 *
 * ⚠️ **必须是专属目录，不能是家人日常用的那个 profile。** 两个理由：
 *   1. Chrome/Edge 对 profile 目录是**独占**的 —— 家人开着浏览器时 agent 就起不来；
 *   2. agent 会在里面登录、装东西、改设置，弄乱家人自己的浏览器是不可接受的。
 * 扫一次码之后 cookie 留在这个目录里，后面几十次搜索都不用再扫 —— 这正是
 * 「持久 profile」的全部价值。
 */
export function browserProfileDir(userDataDir: string): string {
  return path.join(userDataDir, "browser-profile");
}
