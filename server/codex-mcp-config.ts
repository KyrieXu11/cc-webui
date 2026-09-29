// URL 推导：cc-webui 自己那几条 HTTP MCP 路由（server/mcp-bash-route.ts +
// mcp-local-route.ts）。
//
// 文件名里的 "codex" 是历史遗留：这套东西最早只有 Codex 在用。现在两个 executor
// 都走它，剩下的内容也只有 URL 推导了 —— SDK 时代那两个 `createCodexMcp*`
// 构造器随 @openai/codex-sdk 一起删掉了（Codex 的 MCP 配置现在由
// server/executors/codex-executor.ts 直接渲染成 `-c` 覆盖）。

// Named for the HTTP MCP routes in server/mcp-bash-route.ts. Not Codex-only
// any more — both CLI executors reach the same routes.
export type McpRouteName = "bash" | "lark" | "schedule" | "local" | "memory";

export function getMcpRouteUrl(
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      "CC_WEBUI_MCP_URL" | "CC_WEBUI_LARK_MCP_URL" | "PORT"
    >
  > = process.env,
  server: McpRouteName = "bash"
): string {
  // lark 有自己的覆盖变量（历史原因：它先于 schedule / local 出现）。
  if (server === "lark") {
    const larkExplicit = env.CC_WEBUI_LARK_MCP_URL?.trim();
    if (larkExplicit) return larkExplicit;
  }

  // ⚠️ `CC_WEBUI_MCP_URL` 指的是 **bash 那一条**路由，不是「所有 MCP 路由」。
  // 2026-08-30 之前这里写成了「非 lark 一律原样返回它」，于是设了这个变量之后
  // `schedule` 拿到的是 bash 的 URL —— 两条路由指向同一个端点，wakeup 工具在
  // 那种部署下直接不可用，而现场只能看到一个 404/工具缺失。
  // 现在统一按末段改写推导；推导不出来就回落到默认，好过返回一个确定错的 URL。
  const bashUrl = env.CC_WEBUI_MCP_URL?.trim();
  if (bashUrl) {
    if (server === "bash") return bashUrl;
    if (/\/bash\/?$/.test(bashUrl)) {
      return bashUrl.replace(/\/bash\/?$/, `/${server}`);
    }
  }

  const port = Number(env.PORT) || 8787;
  return `http://127.0.0.1:${port}/api/mcp/${server}`;
}

/**
 * 桌面客户端中继路由的 URL。每个本地 MCP server 一条，所以比其它三条多一段路径。
 *
 * 建在 getMcpRouteUrl 之上，好让「回环地址 / PORT / CC_WEBUI_MCP_URL 覆盖」这套
 * 规则只有一处实现。
 */
export function localMcpRouteUrl(
  env: Partial<Pick<NodeJS.ProcessEnv, "CC_WEBUI_MCP_URL" | "PORT">> = process.env,
  serverName: string,
): string {
  return `${getMcpRouteUrl(env, "local")}/${serverName}`;
}
