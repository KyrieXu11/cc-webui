export const CODEX_MCP_TOKEN_ENV = "CC_WEBUI_MCP_TOKEN";

type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };
type CodexConfigObject = { [key: string]: CodexConfigValue };

// Named for the HTTP MCP routes in server/mcp-bash-route.ts. Not Codex-only
// any more — the CLI-driven Claude executor reaches the same routes.
export type McpRouteName = "bash" | "lark" | "schedule" | "local";

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

export function createCodexMcpConfig(
  input: string | { bashUrl: string; larkUrl?: string }
): CodexConfigObject {
  const bashUrl = typeof input === "string" ? input : input.bashUrl;
  const larkUrl = typeof input === "string" ? undefined : input.larkUrl;
  const mcpServers: CodexConfigObject = {
    bash: {
      url: bashUrl,
      bearer_token_env_var: CODEX_MCP_TOKEN_ENV,
      default_tools_approval_mode: "approve",
    },
  };
  if (larkUrl) {
    mcpServers.lark = {
      url: larkUrl,
      bearer_token_env_var: CODEX_MCP_TOKEN_ENV,
      default_tools_approval_mode: "approve",
    };
  }
  return {
    mcp_servers: mcpServers,
  };
}

export function createCodexMcpEnv(
  token: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  env[CODEX_MCP_TOKEN_ENV] = token;
  return env;
}
