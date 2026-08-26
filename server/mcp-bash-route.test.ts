import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";

// Own database: the route now resolves the token's user, and without this it
// would read (and write) the developer's real ~/.cc-webui/cc-webui.db.
const tmp = path.join(os.tmpdir(), `cc-webui-mcp-route-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
const allowedDir = path.join(tmp, "allowed");
const deniedDir = path.join(tmp, "denied");
await fs.mkdir(allowedDir, { recursive: true });
await fs.mkdir(deniedDir, { recursive: true });

const { closeDb } = await import("./db.ts");
const { registerMcpSessionContext, unregisterMcpSessionContext } = await import(
  "./mcp-context.ts"
);
const { mcpBashRoute } = await import("./mcp-bash-route.ts");
const { createUser, setAllowedPaths } = await import("./auth/users.ts");

const app = new Hono();
app.route("/api/mcp", mcpBashRoute);

const rpc = async (token: string, method: string, params: unknown) => {
  const res = await app.request("/api/mcp/bash", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.text();
  return { status: res.status, body };
};

const callTool = (token: string, name: string, args: Record<string, unknown>) =>
  rpc(token, "tools/call", { name, arguments: args });

const unauthorized = await app.request("/api/mcp/bash", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
assert.equal(unauthorized.status, 401);

try {
  // ── the pre-existing smoke test ──────────────────────────────────────────
  const token = randomUUID();
  registerMcpSessionContext({
    token,
    sessionId: "test-session",
    cwd: process.cwd(),
  });
  try {
    const initialized = await rpc(token, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "cc-webui-test", version: "0.0.0" },
    });
    assert.notEqual(initialized.status, 401);
    assert.ok(
      initialized.status >= 200 && initialized.status < 300,
      `expected 2xx initialize response, got ${initialized.status}`,
    );
  } finally {
    unregisterMcpSessionContext(token);
  }

  // ── the token acts as ITS OWN user, not as everyone ──────────────────────
  //
  // These routes never see a login cookie, so this is the only place the
  // account's folder guardrail can be applied to what the model does.

  const alice = createUser({ username: "alice", password: "pw", role: "user" });
  setAllowedPaths(alice.id, [path.join(allowedDir, "**")]);

  // 1. an unbound token (no ownerId) is refused outright — the fail-closed
  //    direction, so a forgotten call site cannot mean "unrestricted".
  const orphanToken = randomUUID();
  registerMcpSessionContext({
    token: orphanToken,
    sessionId: "orphan-session",
    cwd: allowedDir,
  });
  try {
    const out = await callTool(orphanToken, "run", { command: "echo hi" });
    assert.match(out.body, /not bound to a cc-webui account/);
  } finally {
    unregisterMcpSessionContext(orphanToken);
  }

  // 2. a cwd outside the account's whitelist: refused, and the command really
  //    does not run (the message alone would not prove that).
  const deniedToken = randomUUID();
  registerMcpSessionContext({
    token: deniedToken,
    sessionId: "denied-session",
    ownerId: alice.id,
    cwd: deniedDir,
  });
  const marker = path.join(deniedDir, "executed");
  try {
    const out = await callTool(deniedToken, "run", {
      command: `touch ${JSON.stringify(marker)}`,
    });
    assert.match(out.body, /outside the folders alice may open/);
    await assert.rejects(fs.access(marker), "the refused command still ran");
  } finally {
    unregisterMcpSessionContext(deniedToken);
  }

  // 3. inside the whitelist: unchanged behaviour.
  const okToken = randomUUID();
  registerMcpSessionContext({
    token: okToken,
    sessionId: "ok-session",
    ownerId: alice.id,
    cwd: allowedDir,
  });
  const otherToken = randomUUID();
  registerMcpSessionContext({
    token: otherToken,
    sessionId: "other-session",
    ownerId: alice.id,
    cwd: allowedDir,
  });
  try {
    const ran = await callTool(okToken, "run", { command: "echo MCP_OK" });
    assert.match(ran.body, /MCP_OK/);

    // 4. background task ids are process-global and are shown to the model.
    //    Another turn must not be able to read or kill one — even the SAME
    //    user's other turn, since the scope is the conversation.
    const bg = await callTool(okToken, "run", {
      command: "sleep 2",
      run_in_background: true,
    });
    const taskId = /bashTaskId: (bg-[0-9a-f]+)/.exec(bg.body)?.[1];
    assert.ok(taskId, `no bashTaskId in ${bg.body}`);

    for (const tool of ["output", "kill"]) {
      const out = await callTool(otherToken, tool, { bash_id: taskId });
      assert.match(out.body, /No background task with id/, tool);
      assert.ok(out.body.includes(taskId), tool);
    }

    // ...while the turn that spawned it still can.
    const own = await callTool(okToken, "kill", { bash_id: taskId });
    assert.doesNotMatch(own.body, /No background task/);
  } finally {
    unregisterMcpSessionContext(okToken);
    unregisterMcpSessionContext(otherToken);
  }
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
