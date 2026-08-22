import assert from "node:assert/strict";
import {
  CODEX_MCP_TOKEN_ENV,
  createCodexMcpConfig,
  createCodexMcpEnv,
  getMcpRouteUrl,
} from "./codex-mcp-config.ts";

const url = "http://127.0.0.1:8788/api/mcp/bash";

assert.equal(CODEX_MCP_TOKEN_ENV, "CC_WEBUI_MCP_TOKEN");
assert.deepEqual(createCodexMcpConfig(url), {
  mcp_servers: {
    bash: {
      url,
      bearer_token_env_var: "CC_WEBUI_MCP_TOKEN",
      default_tools_approval_mode: "approve",
    },
  },
});
assert.deepEqual(
  createCodexMcpConfig({
    bashUrl: url,
    larkUrl: "http://127.0.0.1:8788/api/mcp/lark",
  }),
  {
    mcp_servers: {
      bash: {
        url,
        bearer_token_env_var: "CC_WEBUI_MCP_TOKEN",
        default_tools_approval_mode: "approve",
      },
      lark: {
        url: "http://127.0.0.1:8788/api/mcp/lark",
        bearer_token_env_var: "CC_WEBUI_MCP_TOKEN",
        default_tools_approval_mode: "approve",
      },
    },
  },
);

assert.deepEqual(
  createCodexMcpEnv("secret-token", {
    PATH: "/bin",
    HOME: "/tmp/home",
    OMITTED: undefined,
  }),
  {
    PATH: "/bin",
    HOME: "/tmp/home",
    CC_WEBUI_MCP_TOKEN: "secret-token",
  }
);

assert.equal(
  getMcpRouteUrl({ PORT: "8799" }),
  "http://127.0.0.1:8799/api/mcp/bash"
);
assert.equal(
  getMcpRouteUrl({ PORT: "8799" }, "lark"),
  "http://127.0.0.1:8799/api/mcp/lark"
);
assert.equal(
  getMcpRouteUrl({ CC_WEBUI_MCP_URL: "http://localhost:9999/custom" }),
  "http://localhost:9999/custom"
);
assert.equal(
  getMcpRouteUrl(
    { CC_WEBUI_MCP_URL: "http://localhost:9999/api/mcp/bash" },
    "lark",
  ),
  "http://localhost:9999/api/mcp/lark",
);
assert.equal(
  getMcpRouteUrl(
    { CC_WEBUI_LARK_MCP_URL: "http://localhost:9999/lark-custom" },
    "lark",
  ),
  "http://localhost:9999/lark-custom",
);
