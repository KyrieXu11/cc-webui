import assert from "node:assert/strict";
import {
  CODEX_MCP_TOKEN_ENV,
  createCodexMcpConfig,
  createCodexMcpEnv,
  getCodexMcpUrl,
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
  getCodexMcpUrl({ PORT: "8799" }),
  "http://127.0.0.1:8799/api/mcp/bash"
);
assert.equal(
  getCodexMcpUrl({ CC_WEBUI_MCP_URL: "http://localhost:9999/custom" }),
  "http://localhost:9999/custom"
);
