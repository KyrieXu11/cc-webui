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
  const explicit =
    server === "lark"
      ? env.CC_WEBUI_LARK_MCP_URL?.trim()
      : env.CC_WEBUI_MCP_URL?.trim();
  if (explicit) return explicit;
  if (server === "lark") {
    const bashUrl = env.CC_WEBUI_MCP_URL?.trim();
    if (bashUrl && /\/bash\/?$/.test(bashUrl)) {
      return bashUrl.replace(/\/bash\/?$/, "/lark");
    }
  }
  const port = Number(env.PORT) || 8787;
  return `http://127.0.0.1:${port}/api/mcp/${server}`;
}

/**
 * 桌面客户端中继路由的 URL。每个本地 MCP server 一条，所以比其它三条多一段路径。
 *
 * ⚠️ 刻意不复用 getMcpRouteUrl(env, "local")：那个函数的覆盖逻辑有个已知的坑 ——
 * `CC_WEBUI_MCP_URL` 一旦设了，**任何非 lark 的 server 名都原样返回它**（上面
 * 第 24-28 行），"schedule" 已经中招。这里自己按 bash 的 URL 改写末段，
 * 顺带把回环/PORT 的默认值仍然只留在上面那一处。
 */
export function localMcpRouteUrl(
  env: Partial<Pick<NodeJS.ProcessEnv, "CC_WEBUI_MCP_URL" | "PORT">> = process.env,
  serverName: string,
): string {
  const bashUrl = env.CC_WEBUI_MCP_URL?.trim();
  if (bashUrl && /\/bash\/?$/.test(bashUrl)) {
    return bashUrl.replace(/\/bash\/?$/, `/local/${serverName}`);
  }
  const port = Number(env.PORT) || 8787;
  return `http://127.0.0.1:${port}/api/mcp/local/${serverName}`;
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
