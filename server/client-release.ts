// 桌面客户端的「当前发布版本」——设计见 docs/desktop-client.md 决策 26/28。
//
// 客户端启动时和用户手点托盘「检查更新…」时各查一次 /api/meta，比 semver 决定
// 要不要提示（**比较在客户端做**，服务端只负责把版本信息如实下发）。
//
// 真相是一个文件：`<dir>/latest.json`。发布 = 把 exe 和这个 json 拷进去，不需要
// 重启服务，所以这里**故意不缓存**（一次 ~200 字节的 readFileSync，调用方是每
// 分钟几次的 /api/meta，省不出什么）。被否掉的两种做法：① 扫目录按文件名猜版本
// ——文件名里的版本和 notes 没地方放，且改名就变成发布动作；② 进 SQLite——这是
// 你手工维护的一行配置，不是索引或关系（AGENTS.md「数据与存储布局」那条规则）。
//
// 没发布过客户端是**正常状态**，不是故障：读不到 / 坏 JSON / 缺字段一律返回
// undefined 且绝不抛 —— 家人的服务端不该因为一个还没发布的客户端而挂掉。

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type DesktopClientRelease = {
  version: string;
  url: string;
  notes?: string;
};

// ⚠️ env 必须在函数体里读：index.ts 的 loadDotEnvOnce() 在所有 import 求值**之后**
// 才跑，模块顶层读 env 永远读不到 .env 里的值（features.ts / office.ts 同款形状）。
export function clientDir(): string {
  return (
    process.env.CC_WEBUI_CLIENT_DIR?.trim() ||
    path.join(os.homedir(), ".cc-webui", "client")
  );
}

function isPlainFilename(name: string): boolean {
  // 这个 name 会被拼进下发给客户端的 URL。它来自本机磁盘上你自己写的 json，
  // 但一个手滑的 "../../x" 会让下发的 URL 指到下载路由的目录之外；在这里挡住
  // 比指望下游每个消费者都记得挡便宜。
  return name === path.basename(name) && name !== "." && name !== "..";
}

export function clientRelease(): DesktopClientRelease | undefined {
  const file = path.join(clientDir(), "latest.json");

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT/ENOTDIR = 还没发布过客户端，别刷日志。其它错（权限等）值得一行线索。
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      console.warn(`[client-release] 读不了 ${file}：${(err as Error).message}`);
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 文件在但坏了 = 你发布时手滑了，静默返回 undefined 会让「客户端收不到更新」
    // 完全没有排查线索。
    console.warn(`[client-release] ${file} 不是合法 JSON：${(err as Error).message}`);
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") {
    console.warn(`[client-release] ${file} 不是一个对象，忽略`);
    return undefined;
  }

  const { version, file: fileName, notes } = parsed as Record<string, unknown>;
  if (typeof version !== "string" || !version.trim()) {
    console.warn(`[client-release] ${file} 缺 version，忽略`);
    return undefined;
  }
  if (typeof fileName !== "string" || !fileName.trim()) {
    console.warn(`[client-release] ${file} 缺 file，忽略`);
    return undefined;
  }
  if (!isPlainFilename(fileName.trim())) {
    console.warn(`[client-release] ${file} 的 file 必须是纯文件名（不含目录），忽略`);
    return undefined;
  }

  const release: DesktopClientRelease = {
    version: version.trim(),
    // 相对路径：客户端拿它拼自己那份 base URL（决策 27，主进程带 cookie 自己下）。
    url: `/api/client/download/${fileName.trim()}`,
  };
  // notes 可选，dialog 里显示；空串等于没写。
  if (typeof notes === "string" && notes.trim()) release.notes = notes;
  return release;
}
