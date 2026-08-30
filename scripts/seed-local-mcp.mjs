#!/usr/bin/env node
// 给某个账号配置「他自己那台机器上要起哪些本地 MCP server」。
//
// 决策 16 说 v1 手工配、不做管理界面（配置格式头两版几乎肯定要改，过早做界面
// 是给自己上枷锁）。但「手工」不该等于「手写 SQL」—— 这个脚本就是那个手柄。
//
// 用法：
//   node scripts/seed-local-mcp.mjs <username>            # 装上 v1 的默认三件套
//   node scripts/seed-local-mcp.mjs <username> --list      # 看现在配了什么
//   node scripts/seed-local-mcp.mjs <username> --clear     # 清空
//
// v1 的默认三件套（决策 17 + 18）：
//   browser   —— 浏览器自动化。**用现成的 @playwright/mcp**，不自己写（决策 11）。
//                驱动系统上已有的 Chrome / Edge，不下载 Chromium（决策 24）。
//   fs        —— 家人机器上的文件读写。用官方的 filesystem server。
//   transfer  —— 两个文件系统之间搬东西（决策 18，v1 必备不是加分项）。
//
// ⚠️ **故意不给本机 shell**（决策 17）。理由不是安全（那条已经接受了），是调试
// 成本：shell 一上，任何失败都可能来自远端环境差异，而你人不在那台机器前。
// 等浏览器那条链稳了再加，加的时候只是这里多一行，客户端一个字都不用改。

import path from "node:path";

const [, , username, flag] = process.argv;
if (!username) {
  console.error("用法：node scripts/seed-local-mcp.mjs <username> [--list|--clear]");
  process.exit(1);
}

const { getUserByUsername } = await import("../server/auth/users.ts");
const { listLocalMcpServers, setLocalMcpServers } = await import(
  "../server/devices/store.ts"
);

const user = getUserByUsername(username);
if (!user) {
  console.error(`没有这个账号：${username}`);
  process.exit(1);
}

if (flag === "--list") {
  const rows = listLocalMcpServers(user.id);
  if (rows.length === 0) {
    console.log(`${username} 还没有配置任何本地 MCP server。`);
  } else {
    console.log(`${username} 的本地 MCP server：`);
    for (const r of rows) console.log("  " + JSON.stringify(r));
  }
  process.exit(0);
}

if (flag === "--clear") {
  setLocalMcpServers(user.id, []);
  console.log(`已清空 ${username} 的本地 MCP server。`);
  process.exit(0);
}

// ⚠️ 这里用 npx 而不是 bundled，是因为 @playwright/mcp 和 filesystem server 都是
// 第三方包，把它们打进安装包要连 node_modules 一起打（体积和许可都不划算）。
// 代价是**家人机器上要有 Node**（决策 23 的 (c) 混合方案里的 npx 逃生口），
// 而且首次运行要联网拉包。transfer 是我们自己的，走 bundled，零依赖。
//
// 想彻底零依赖，把这两条也改成 bundled 并在 desktop/src/servers/ 下各写一个薄封装。
const DEFAULTS = [
  {
    name: "browser",
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: [
      "-y",
      "@playwright/mcp@latest",
      // 决策 24：驱动系统上已有的浏览器，不下载 Chromium。Windows 上 Edge 必然存在，
      // 装了 Chrome 的话把这里改成 chrome。
      "--browser",
      "msedge",
      // 决策 24：专属持久 profile。扫一次码，cookie 留着，后面几十次搜索都不用再扫。
      // ⚠️ 绝不能指向家人日常那个 profile —— 浏览器对 profile 目录是独占的，
      // 他开着浏览器 agent 就起不来；而且 agent 会在里面登录、改设置。
      "--user-data-dir",
      "${CC_WEBUI_BROWSER_PROFILE}",
    ],
  },
  {
    name: "fs",
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      // 家人机器上允许 agent 读写的目录。**装机时按人改这一行。**
      path.join("%USERPROFILE%", "Desktop"),
      path.join("%USERPROFILE%", "Downloads"),
      path.join("%USERPROFILE%", "Documents"),
    ],
  },
  {
    name: "transfer",
    bundled: "transfer",
  },
];

setLocalMcpServers(user.id, DEFAULTS);
console.log(`已给 ${username} 配上 v1 默认的 ${DEFAULTS.length} 个本地 MCP server：`);
for (const d of DEFAULTS) console.log("  - " + d.name);
console.log(
  "\n下一步：让 " +
    username +
    " 的桌面客户端重连一次（配置在连上服务端时下发），然后在网页里发一条消息，" +
    "系统提示里会出现 mcp__local-* 的说明。",
);
console.log(
  "\n⚠️ browser / fs 走的是 npx，家人机器上要有 Node 且首次运行要联网拉包。" +
    "transfer 是内置的，零依赖。",
);
