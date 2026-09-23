import assert from "node:assert/strict";
import { getMcpRouteUrl, localMcpRouteUrl } from "./codex-mcp-config.ts";

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

// ── CC_WEBUI_MCP_URL 指的是 bash 那一条，不是「所有 MCP 路由」──────────────
//
// 2026-08-30 修：之前写成「非 lark 一律原样返回它」，于是设了这个变量之后
// schedule 拿到的是 bash 的 URL——两条路由指向同一个端点，wakeup 工具在那种
// 部署下直接不可用，而现场只能看到一个工具缺失。local 会继承同一个 bug。
assert.equal(
  getMcpRouteUrl(
    { CC_WEBUI_MCP_URL: "http://localhost:9999/api/mcp/bash" },
    "schedule",
  ),
  "http://localhost:9999/api/mcp/schedule",
  "schedule 必须按末段改写推导，不能原样返回 bash 的 URL",
);
assert.equal(
  getMcpRouteUrl(
    { CC_WEBUI_MCP_URL: "http://localhost:9999/api/mcp/bash" },
    "local",
  ),
  "http://localhost:9999/api/mcp/local",
);
// 推导不出来（不以 /bash 结尾）就回落到默认——好过返回一个确定指错的 URL。
assert.equal(
  getMcpRouteUrl({ CC_WEBUI_MCP_URL: "http://localhost:9999/custom", PORT: "8790" }, "schedule"),
  "http://127.0.0.1:8790/api/mcp/schedule",
);

// ── localMcpRouteUrl 建在上面那套规则之上 ─────────────────────────────────
assert.equal(
  localMcpRouteUrl({ PORT: "8790" }, "browser"),
  "http://127.0.0.1:8790/api/mcp/local/browser",
);
assert.equal(
  localMcpRouteUrl({ CC_WEBUI_MCP_URL: "https://h/api/mcp/bash" }, "browser"),
  "https://h/api/mcp/local/browser",
);

console.log("codex-mcp-config.test.ts: all assertions passed");
