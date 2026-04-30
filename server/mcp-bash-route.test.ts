import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  registerCodexMcpContext,
  unregisterCodexMcpContext,
} from "./codex-mcp-context.ts";
import { mcpBashRoute } from "./mcp-bash-route.ts";

const app = new Hono();
app.route("/api/mcp", mcpBashRoute);

const unauthorized = await app.request("/api/mcp/bash", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
assert.equal(unauthorized.status, 401);

const token = randomUUID();
registerCodexMcpContext({
  token,
  sessionId: "test-session",
  cwd: process.cwd(),
});

try {
  const initialized = await app.request("/api/mcp/bash", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "cc-webui-test", version: "0.0.0" },
      },
    }),
  });
  assert.notEqual(initialized.status, 401);
  assert.ok(
    initialized.status >= 200 && initialized.status < 300,
    `expected 2xx initialize response, got ${initialized.status}`
  );
} finally {
  unregisterCodexMcpContext(token);
}

