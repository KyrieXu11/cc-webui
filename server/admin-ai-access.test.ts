import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-ai-access-"));
Object.assign(process.env, {
  CC_WEBUI_DB: path.join(tmp, "db"),
  CC_WEBUI_WORKSPACES_DIR: path.join(tmp, "workspaces"),
  CC_WEBUI_GROUPS_DIR: path.join(tmp, "groups"),
  CC_WEBUI_SESSION_INDEX: path.join(tmp, "index"),
  CC_WEBUI_COOKIE_SECRET_FILE: path.join(tmp, "cookie"),
  CC_WEBUI_CLAUDE_PROJECTS_DIR: path.join(tmp, "claude"),
  CODEX_SESSIONS_DIR: path.join(tmp, "codex"),
  CC_WEBUI_DOTENV: path.join(tmp, "empty.env"),
  CC_WEBUI_PROJECT_MEMORY_DIR: path.join(tmp, "memories")
});
await fs.writeFile(process.env.CC_WEBUI_DOTENV!, "");
const {
  createApp
} = await import("./app.ts");
const {
  createUser,
  getAllowedProviders,
  getUserDefaults,
  assertProviderAllowed
} = await import("./auth/users.ts");
const {
  issueSession,
  SESSION_COOKIE
} = await import("./auth/session.ts");
const {
  recordOwner
} = await import("./auth/ownership.ts");
const {
  modelOptionsForProvider
} = await import("../src/lib/settings.ts");
const {
  applyUserDefaults
} = await import("../src/lib/user-defaults.ts");
const {
  DEFAULT_SETTINGS
} = await import("../src/lib/settings.ts");
const {
  closeDb
} = await import("./db.ts");
try {
  const app = createApp();
  const root = createUser({
    username: "root",
    password: "pw",
    role: "admin",
    allowedPaths: [tmp]
  });
  const member = createUser({
    username: "rebecca",
    password: "pw",
    role: "user",
    allowedPaths: [tmp]
  });
  const request = (userId: string, url: string, method = "GET", body?: unknown) => app.request(url, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${issueSession(userId)}`,
      "content-type": "application/json"
    },
    ...(body !== undefined ? {
      body: JSON.stringify(body)
    } : {})
  });
  const patch = (body: unknown) => request(root.id, `/api/admin/users/${member.id}`, "PATCH", body);
  assert.deepEqual(getAllowedProviders(member), ["claude"]);
  assert.equal((await request(member.id, "/api/codex/chat", "POST", {
    prompt: "",
    cwd: tmp
  })).status, 403);
  const model = modelOptionsForProvider("codex")[0].id;
  const changed = await patch({
    allowedProviders: ["codex"],
    defaults: {
      provider: "codex",
      model,
      effort: "high"
    }
  });
  assert.equal(changed.status, 200);
  const me = await (await request(member.id, "/api/auth/me")).json();
  assert.equal(me.user.role, "user", "Codex grant does not grant admin rights");
  assert.deepEqual(me.allowedProviders, ["codex"]);
  assert.equal(me.defaults.provider, "codex");
  const settings = applyUserDefaults(DEFAULT_SETTINGS, me.defaults);
  assert.equal(settings.agentProvider, "codex");
  assert.equal(settings.model, model);
  assert.equal(settings.effort, "high");
  assert.equal((await request(member.id, "/api/codex/chat", "POST", {
    prompt: "",
    cwd: tmp
  })).status, 400, "provider allowed; no paid CLI run with empty prompt");
  assert.equal((await request(member.id, "/api/chat", "POST", {
    prompt: "hi",
    cwd: tmp
  })).status, 403);
  assert.equal((await request(member.id, "/api/codex/chat", "POST", {
    prompt: "hi",
    cwd: tmp,
    permissionMode: "bypassPermissions"
  })).status, 403);
  assert.equal((await request(member.id, `/api/admin/users/${member.id}`, "PATCH", {
    allowedProviders: ["claude", "codex"]
  })).status, 403);
  assert.equal((await patch({
    allowedProviders: [],
    password: "changed"
  })).status, 400);
  assert.equal((await patch({
    defaults: {
      provider: "claude",
      model: "opus"
    }
  })).status, 400);
  assert.equal((await patch({
    defaults: {
      provider: "codex",
      model,
      effort: "not-a-tier"
    }
  })).status, 400);
  const foreign = randomUUID();
  recordOwner(foreign, "codex", root.id);
  assert.equal((await request(member.id, "/api/codex/chat", "POST", {
    prompt: "",
    cwd: tmp,
    sessionId: foreign
  })).status, 404, "grant does not authorize another person's resume ID");
  assertProviderAllowed(member.id, "codex");
  assert.throws(() => assertProviderAllowed(member.id, "claude"), /不能使用/);
  assert.throws(() => assertProviderAllowed(undefined, "codex"), /不能使用/);
  const groupId = randomUUID(); recordOwner(groupId, "group", member.id);
  process.env.CC_WEBUI_GROUPS_ENABLED = "1";
  const groupApp = createApp();
  const groupTurn = await groupApp.request(`/api/groups/${groupId}/turn`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${issueSession(member.id)}`, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  assert.equal(groupTurn.status, 403, "member cannot evade provider policy through a group turn");
  delete process.env.CC_WEBUI_GROUPS_ENABLED;
  const version = getUserDefaults(member.id)!.updatedAt;
  assert.equal((await patch({
    allowedProviders: ["claude"]
  })).status, 200);
  assert.equal(getUserDefaults(member.id)!.provider, "claude");
  assert.ok(getUserDefaults(member.id)!.updatedAt > version);
  assert.equal((await request(member.id, "/api/codex/chat", "POST", {
    prompt: "",
    cwd: tmp
  })).status, 403);
} finally {
  closeDb();
  await fs.rm(tmp, {
    recursive: true,
    force: true
  });
}
console.log("admin provider access/defaults tests passed");
