import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-memory-test-"));
Object.assign(process.env, {
  CC_WEBUI_DB: path.join(tmp, "test.db"),
  CC_WEBUI_PROJECT_MEMORY_DIR: path.join(tmp, "memories"),
  CC_WEBUI_WORKSPACES_DIR: path.join(tmp, "workspaces"),
  CC_WEBUI_GROUPS_DIR: path.join(tmp, "groups"),
  CC_WEBUI_CLAUDE_PROJECTS_DIR: path.join(tmp, "claude"),
  CC_WEBUI_SESSION_INDEX: path.join(tmp, "sessions.json"),
  CODEX_SESSIONS_DIR: path.join(tmp, "codex"),
  CC_WEBUI_COOKIE_SECRET_FILE: path.join(tmp, "cookie"),
  CC_WEBUI_DOTENV: path.join(tmp, "empty.env"),
  CC_WEBUI_PROJECT_MEMORY_ENABLED: "true"
});
await fs.writeFile(process.env.CC_WEBUI_DOTENV!, "");
await fs.mkdir(path.join(tmp, "project"));
await fs.mkdir(path.join(tmp, "other"));
const {
  createUser,
  setAllowedPaths,
  setAllowedProviders,
  deleteUser
} = await import("./auth/users.ts");
const {
  resolveMemoryScope
} = await import("./project-memory/scope.ts");
const {
  saveMemory,
  readMemory,
  listMemory,
  searchMemory,
  deleteMemory,
  memoryRoot,
  MAX_MEMORY_BYTES
} = await import("./project-memory/store.ts");
const {
  memorySnapshot,
  memoryPrompt
} = await import("./project-memory/prompt.ts");
const {
  prepareProjectMemory
} = await import("./project-memory/runtime.ts");
const {
  importClaudeMemory
} = await import("./project-memory/import.ts");
const {
  projectSlug
} = await import("./claude-sessions.ts");
const {
  createApp
} = await import("./app.ts");
const {
  issueSession,
  SESSION_COOKIE
} = await import("./auth/session.ts");
const {
  registerMcpSessionContext,
  unregisterMcpSessionContext
} = await import("./mcp-context.ts");
const {
  getDb,
  closeDb
} = await import("./db.ts");
const actor = createUser({
  username: "alice",
  password: "x",
  role: "user",
  allowedPaths: [tmp]
});
const bob = createUser({
  username: "bob",
  password: "x",
  role: "user",
  allowedPaths: [tmp]
});
const source = {
  provider: "claude",
  sessionId: randomUUID()
};
const content = {
  operation_id: "create-tests",
  name: "feedback-tests",
  description: "测试使用真实数据库",
  type: "feedback" as const,
  body: "测试必须使用真实数据库。\n\n**Why:** 不掩盖迁移差异。\n**How to apply:** 集成测试。"
};
try {
  const scope = await resolveMemoryScope(actor.id, path.join(tmp, "project"));
  const alias = path.join(tmp, "alias");
  await fs.symlink(scope.cwd, alias);
  assert.equal((await resolveMemoryScope(actor.id, alias)).id, scope.id);
  const other = await resolveMemoryScope(actor.id, path.join(tmp, "other"));
  const foreign = await resolveMemoryScope(bob.id, scope.cwd);
  const saved = await saveMemory(scope, content, source);
  assert.equal(saved.revision, 1);
  assert.equal((await readMemory(scope, saved.id)).body, content.body);
  assert.equal((await saveMemory(scope, content, source)).replayed, true);
  assert.equal((await listMemory(scope)).total, 1);
  await assert.rejects(saveMemory(scope, {
    ...content,
    body: "different"
  }, source), /同一 operation_id/);
  await assert.rejects(saveMemory(scope, {
    ...content,
    operation_id: "duplicate"
  }, source), /同名/);
  await assert.rejects(readMemory(other, saved.id), /没有该记忆/);
  await assert.rejects(readMemory(foreign, saved.id), /没有该记忆/);
  assert.equal((await searchMemory(scope, "数据库")).entries[0].id, saved.id);
  assert.equal((await searchMemory(scope, "%")).entries.length, 0, "SQL wildcard is literal");
  const updates = await Promise.allSettled(["a", "b"].map(key => saveMemory(scope, {
    ...content,
    operation_id: "update-" + key,
    id: saved.id,
    expected_revision: 1,
    body: key
  }, {
    provider: "codex",
    sessionId: source.sessionId
  })));
  assert.equal(updates.filter(r => r.status === "fulfilled").length, 1);
  const current = await readMemory(scope, saved.id);
  assert.equal(current.revision, 2);
  assert.equal(current.provider, "codex");
  const snap = await memorySnapshot(scope);
  assert.equal(snap.entries[0].id, saved.id);
  assert.ok(!JSON.stringify(snap).includes("**Why:**"), "only metadata is injected");
  assert.match(memoryPrompt(true), /mcp__memory__save/);
  assert.doesNotMatch(memoryPrompt(true), /write.*Write tool/);

  const configuredRoot = process.env.CC_WEBUI_PROJECT_MEMORY_DIR!;
  const unsafeRoot = path.join(tmp, "not-a-memory-library");
  await fs.mkdir(unsafeRoot); await fs.writeFile(path.join(unsafeRoot, "user-note.md"), "never remove me");
  process.env.CC_WEBUI_PROJECT_MEMORY_DIR = unsafeRoot;
  try { await assert.rejects(saveMemory(scope, { ...content, operation_id: "unsafe-root", name: "unsafe" }, source), /非空目录/); }
  finally { process.env.CC_WEBUI_PROJECT_MEMORY_DIR = configuredRoot; }
  assert.equal(await fs.readFile(path.join(unsafeRoot, "user-note.md"), "utf8"), "never remove me");
  const originalDir = path.join(process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR!, "project", "memory");
  process.env.CC_WEBUI_PROJECT_MEMORY_DIR = originalDir;
  try { await assert.rejects(saveMemory(scope, { ...content, operation_id: "native-root", name: "native" }, source), /原生记忆目录/); }
  finally { process.env.CC_WEBUI_PROJECT_MEMORY_DIR = configuredRoot; }
  await assert.rejects(fs.stat(originalDir), /ENOENT/, "even an empty native directory is never written");

  // Limits do not shrink the actual searchable project library.
  for (let n = 0; n < 202; n++) await saveMemory(scope, {
    operation_id: `bulk-${n}`,
    name: `reference-${n}`,
    description: `长索引条目 ${n} ` + "背景".repeat(50),
    type: "reference",
    body: "资料指针"
  }, source);
  const largeSnapshot = await memorySnapshot(scope);
  assert.ok(largeSnapshot.truncated);
  assert.ok(largeSnapshot.entries.length <= 200);
  assert.ok(JSON.stringify(largeSnapshot).length <= 25000);
  assert.equal((await searchMemory(scope, "数据库")).entries[0].id, saved.id);
  assert.ok((await listMemory(scope, 100, 100)).next_cursor !== null);

  // A new process cleans crash leftovers, but retains every committed revision.
  const orphanDir = path.join(memoryRoot(), actor.id, scope.projectKey, randomUUID());
  await fs.mkdir(orphanDir);
  const orphan = path.join(orphanDir, randomUUID() + ".md");
  await fs.writeFile(orphan, "uncommitted");
  const unrelated = path.join(memoryRoot(), "unrelated.md");
  await fs.writeFile(unrelated, "must survive recovery");
  await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `const store = await import('./server/project-memory/store.ts'); await store.recoverMemoryFiles(); (await import('./server/db.ts')).closeDb();`], {
    cwd: process.cwd(),
    env: process.env
  });
  await assert.rejects(fs.stat(orphan), /ENOENT/);
  assert.equal(await fs.readFile(unrelated, "utf8"), "must survive recovery");
  assert.equal((await readMemory(scope, saved.id)).revision, 2);
  const location = getDb().prepare("SELECT file FROM project_memories WHERE id=?").get(saved.id) as {
    file: string;
  };
  const storedFile = path.join(memoryRoot(), location.file);
  const originalBytes = await fs.readFile(storedFile);
  await fs.writeFile(storedFile, "external tampering");
  await assert.rejects(readMemory(scope, saved.id), /被外部修改/);
  await fs.writeFile(storedFile, originalBytes);
  const app = createApp();
  let notifications = 0;
  const token = randomUUID();
  setAllowedProviders(actor.id, ["claude", "codex"]);
  registerMcpSessionContext({
    token,
    sessionId: source.sessionId,
    ownerId: actor.id,
    cwd: scope.cwd,
    projectMemory: {
      scope,
      writable: true,
      provider: "codex"
    },
    onMemoryUpdated: () => notifications++
  });
  const call = async (name: string, args: Record<string, unknown>, useToken = token) => {
    const res = await app.request("/api/mcp/memory", {
      method: "POST",
      headers: {
        authorization: `Bearer ${useToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args
        }
      })
    });
    const text = await res.text();
    return {
      status: res.status,
      text
    };
  };
  const read = await call("read", {
    id: saved.id
  });
  assert.equal(read.status, 200);
  assert.match(read.text, /feedback-tests/, "Codex sees Claude-created memory");
  const write = await call("save", {
    ...content,
    operation_id: "mcp-new",
    name: "project-release",
    type: "project",
    body: "截止时间为 2026-10-01"
  });
  assert.equal(write.status, 200);
  assert.doesNotMatch(write.text, /isError.*true/);
  assert.equal(notifications, 1);
  await call("save", {
    ...content,
    operation_id: "mcp-new",
    name: "project-release",
    type: "project",
    body: "截止时间为 2026-10-01"
  });
  assert.equal(notifications, 1, "idempotent retry emits no extra event");
  const plan = randomUUID();
  registerMcpSessionContext({
    token: plan,
    sessionId: source.sessionId,
    ownerId: actor.id,
    cwd: scope.cwd,
    projectMemory: {
      scope,
      writable: false,
      provider: "claude"
    }
  });
  assert.match((await call("save", {
    ...content,
    operation_id: "plan-write",
    name: "should-not-save"
  }, plan)).text, /read_only/);
  assert.equal((await call("read", {
    id: saved.id
  }, plan)).status, 200);
  const group = randomUUID();
  registerMcpSessionContext({
    token: group,
    sessionId: source.sessionId,
    ownerId: actor.id,
    cwd: scope.cwd
  });
  assert.equal((await call("read", {
    id: saved.id
  }, group)).status, 403, "real actor without capability is still denied");
  unregisterMcpSessionContext(group);
  unregisterMcpSessionContext(plan);
  assert.match((await call("read", {
    id: "00000000-0000-4000-8000-000000000000"
  })).text, /not_found/);
  setAllowedPaths(actor.id, [other.cwd]);
  assert.match((await call("read", {
    id: saved.id
  })).text, /scope_unavailable/);
  setAllowedPaths(actor.id, [tmp]);
  unregisterMcpSessionContext(token);
  assert.equal((await call("read", {
    id: saved.id
  })).status, 401);

  // Native input is copied only after an explicit import; the source stays byte-identical.
  const native = path.join(process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR!, projectSlug(scope.cwd), "memory");
  await fs.mkdir(native, {
    recursive: true
  });
  const raw = "---\nname: reference-dashboard\ndescription: 项目看板\nmetadata:\n  type: reference\n---\n\n看板在外部系统。";
  await fs.writeFile(path.join(native, "reference.md"), raw);
  const imported = await importClaudeMemory(scope, ["reference.md"]);
  assert.ok(!(imported[0] as {
    error?: string;
  }).error);
  assert.equal(((await importClaudeMemory(scope, ["reference.md"]))[0] as {
    replayed?: boolean;
  }).replayed, true);
  assert.equal(await fs.readFile(path.join(native, "reference.md"), "utf8"), raw);
  await assert.rejects(importClaudeMemory(scope, ["../../other.md"]), /枚举/);
  const longBody = "长记忆，保留完整原文。\n".repeat(700);
  const longRaw = "---\nname: reference-long\ndescription: 较长的旧记忆\nmetadata:\n  type: reference\n---\n" + longBody;
  assert.ok(Buffer.byteLength(longRaw) > 16 * 1024);
  await fs.writeFile(path.join(native, "long.md"), longRaw);
  const longImport = await importClaudeMemory(scope, ["long.md"]);
  assert.ok("id" in longImport[0]);
  assert.equal((await readMemory(scope, (longImport[0] as { id: string }).id)).body, longBody);
  assert.equal(await fs.readFile(path.join(native, "long.md"), "utf8"), longRaw);
  const manifest = path.join(tmp, "migration-plan.json");
  const report = path.join(tmp, "migration-report.json");
  await fs.writeFile(manifest, JSON.stringify({ projects: [{ username: "alice", cwd: scope.cwd }] }));
  await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/import-project-memory.ts", "--apply", "--manifest", manifest, "--report", report], { cwd: process.cwd(), env: process.env });
  const migration = JSON.parse(await fs.readFile(report, "utf8"));
  assert.equal(migration.projects[0].results.length, 2);
  assert.ok(migration.projects[0].results.every((r: { replayed: boolean }) => r.replayed));
  assert.ok(!JSON.stringify(migration).includes(longBody), "migration reports never contain memory bodies");



  // UI uses the current actor and preserves the original read-only endpoint.
  const cookie = `${SESSION_COOKIE}=${issueSession(actor.id)}`;
  assert.equal((await app.request(`/api/project-memory?cwd=${encodeURIComponent(scope.cwd)}`, {
    headers: {
      cookie
    }
  })).status, 200);
  assert.equal((await app.request(`/api/memory?cwd=${encodeURIComponent(scope.cwd)}`, {
    method: "PUT",
    headers: {
      cookie
    }
  })).status, 404);
  const remove = fs.rm;
  const targetFolder = path.join(memoryRoot(), actor.id, scope.projectKey, saved.id);
  fs.rm = async (...args) => {
    if (args[0] === targetFolder) throw new Error("synthetic cleanup failure");
    return remove(...args);
  };
  try {
    await assert.rejects(deleteMemory(scope, {
      operation_id: "forget-tests",
      id: saved.id,
      expected_revision: 2
    }), /停止召回/);
    await assert.rejects(readMemory(scope, saved.id), /没有该记忆/);
  } finally {
    fs.rm = remove;
  }
  const deleted = await deleteMemory(scope, {
    operation_id: "forget-tests",
    id: saved.id,
    expected_revision: 2
  });
  assert.equal(deleted.cleanup_pending, false);
  await assert.rejects(readMemory(scope, saved.id), /没有该记忆/);
  assert.equal((await deleteMemory(scope, {
    operation_id: "forget-tests",
    id: saved.id,
    expected_revision: 2
  })).replayed, true);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM project_memory_revisions WHERE memory_id=?").get(saved.id)!.n, 0);
  await assert.rejects(fs.stat(path.join(memoryRoot(), actor.id, scope.projectKey, saved.id)), /ENOENT/);
  await assert.rejects(saveMemory(scope, {
    ...content,
    operation_id: "large",
    name: "too-large",
    body: "中".repeat(Math.ceil(MAX_MEMORY_BYTES / 3))
  }, source), /32 KiB/);
  assert.equal(await prepareProjectMemory(actor.id, scope.cwd, "claude", "plan").then(r => r?.capability.writable), false);
  process.env.CC_WEBUI_PROJECT_MEMORY_ENABLED = "false";
  assert.equal(await prepareProjectMemory(actor.id, scope.cwd, "claude"), null);
  deleteUser(actor.id);
  await assert.rejects(listMemory(scope), /账号不可用/);
} finally {
  closeDb();
  await fs.rm(tmp, {
    recursive: true,
    force: true
  });
}
console.log("project memory store/MCP/import tests passed");
