// esbuild 打包。
//
// ⚠️ 为什么不是 `tsc`：本仓库的 import 全都写 `.ts` 后缀（根 tsconfig 开了
// `allowImportingTsExtensions`），而那个选项要求 `noEmit` —— tsc 因此**不能**
// 用来产出。改成无后缀 import 会和整个仓库的风格分叉。esbuild 认 `.ts` 后缀，
// 一条命令解决，顺带把跨目录 import 的 ../../server/devices/protocol.ts 打进来。
//
// 产出：
//   dist/main.mjs          Electron 主进程
//   dist/servers/*.mjs     内置 MCP server（决策 23：家人机器零依赖）
//
// `electron` 是 external：它由运行时提供，打进去会炸。

import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import path from "node:path";

const SERVERS_DIR = "src/servers";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  // ESM 里 __dirname / require 不存在，而某些依赖会用到它们。
  banner: {
    js:
      "import { createRequire as __cr } from 'node:module';" +
      "const require = __cr(import.meta.url);",
  },
};

await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  external: ["electron"],
});

const servers = (await readdir(SERVERS_DIR)).filter((f) => f.endsWith(".ts"));
if (servers.length > 0) {
  await build({
    ...common,
    entryPoints: servers.map((f) => path.join(SERVERS_DIR, f)),
    outdir: "dist/servers",
    outExtension: { ".js": ".mjs" },
  });
}

console.log(`[build] main + ${servers.length} bundled server(s)`);
