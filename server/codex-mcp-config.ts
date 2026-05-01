export const CODEX_MCP_TOKEN_ENV = "CC_WEBUI_MCP_TOKEN";

type CodexConfigValue =
  | string
  | number
  | boolean
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue };
type CodexConfigObject = { [key: string]: CodexConfigValue };

export function getCodexMcpUrl(
  env: Partial<Pick<NodeJS.ProcessEnv, "CC_WEBUI_MCP_URL" | "PORT">> = process.env
): string {
  const explicit = env.CC_WEBUI_MCP_URL?.trim();
  if (explicit) return explicit;
  const port = Number(env.PORT) || 8787;
  return `http://127.0.0.1:${port}/api/mcp/bash`;
}

export function createCodexMcpConfig(url: string): CodexConfigObject {
  return {
    mcp_servers: {
      bash: {
        url,
        bearer_token_env_var: CODEX_MCP_TOKEN_ENV,
        default_tools_approval_mode: "approve",
      },
    },
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
