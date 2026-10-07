import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-sessions-list-"));
Object.assign(process.env, { CC_WEBUI_DB: path.join(tmp, "db"), CC_WEBUI_COOKIE_SECRET_FILE: path.join(tmp, "cookie"),
  CC_WEBUI_WORKSPACES_DIR: path.join(tmp, "workspaces"), CC_WEBUI_GROUPS_DIR: path.join(tmp, "groups"),
  CC_WEBUI_CLAUDE_PROJECTS_DIR: path.join(tmp, "claude"), CODEX_SESSIONS_DIR: path.join(tmp, "codex"),
  CC_WEBUI_DOTENV: path.join(tmp, "empty.env"), CC_WEBUI_CODEX_MODELS_CACHE: path.join(tmp, "no-models") });
await fs.writeFile(process.env.CC_WEBUI_DOTENV!, "");
const { createApp } = await import("./app.ts");
const { createUser } = await import("./auth/users.ts");
const { recordOwner } = await import("./auth/ownership.ts");
const { setShares } = await import("./auth/sharing.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { projectSlug, getClaudeSessionMessages } = await import("./claude-sessions.ts");
const { appendCodexTurn } = await import("./session-store.ts");
const { closeDb } = await import("./db.ts");
const cwd = path.join(tmp, "project"), claudeDir = path.join(process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR!, projectSlug(cwd));
await fs.mkdir(claudeDir, { recursive: true });
await fs.mkdir(process.env.CODEX_SESSIONS_DIR!, { recursive: true });
const writeClaude = async (id: string, prompt: string, mtime: number) => {
  const file = path.join(claudeDir, `${id}.jsonl`);
  await fs.writeFile(file, JSON.stringify({ type: "user", sessionId: id, cwd, message: { content: prompt } }) + "\n");
  await fs.utimes(file, mtime / 1000, mtime / 1000);
  return file;
};
try {
  const app = createApp();
  const admin = createUser({ username: "admin", password: "x", role: "admin", allowedPaths: [tmp] });
  const member = createUser({ username: "member", password: "x", role: "user", allowedPaths: [tmp] });
  const mine = randomUUID(), shared = randomUUID();
  const longPrompt = "prefix " + "x".repeat(1024 * 1024) + " SEARCH_TAIL_SENTINEL";
  const file = await writeClaude(mine, longPrompt, 1000);
  await writeClaude(shared, "shared older conversation", 2000);
  recordOwner(mine, "claude", member.id);
  recordOwner(shared, "claude", admin.id);
  setShares({ resourceId: shared, kind: "claude", userIds: [member.id], sharedBy: admin.id, ownerId: admin.id });
  // Other people's newer rows must not consume the member's page limit.
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    await writeClaude(id, "new admin conversation", 3000 + i);
    recordOwner(id, "claude", admin.id);
  }
  const list = async (id: string, provider: string, limit: number, compact = false) => {
    const res = await app.request(`/api/sessions?cwd=${encodeURIComponent(cwd)}&provider=${provider}&limit=${limit}${compact ? "&compact=1" : ""}`, {
      headers: { cookie: `${SESSION_COOKIE}=${issueSession(id)}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()).sessions;
  };
  assert.deepEqual((await list(member.id, "claude", 1)).map((s: any) => s.sessionId), [shared]);
  assert.equal((await list(member.id, "claude", 2)).length, 2);
  const compact = await list(member.id, "claude", 2, true);
  assert.equal(compact.find((s: any) => s.sessionId === mine).firstPrompt.length, 256);
  assert(Buffer.byteLength(JSON.stringify(compact)) < 3000);
  const full = await list(member.id, "claude", 2);
  assert(full.find((s: any) => s.sessionId === mine).firstPrompt.endsWith("SEARCH_TAIL_SENTINEL"), "compact reads cannot truncate full search cache");
  assert.equal((await getClaudeSessionMessages(mine, { dir: cwd }))[0].message &&
    ((await getClaudeSessionMessages(mine, { dir: cwd }))[0].message as any).content, longPrompt, "history unchanged");
  await fs.appendFile(file, JSON.stringify({ type: "ai-title", aiTitle: "updated title" }) + "\n");
  assert.equal((await list(member.id, "claude", 2))[0].customTitle, "updated title", "append invalidates metadata cache");
  setShares({ resourceId: shared, kind: "claude", userIds: [], sharedBy: admin.id, ownerId: admin.id });
  assert.deepEqual((await list(member.id, "claude", 2)).map((s: any) => s.sessionId), [mine], "warm cache cannot retain revoked sharing");
  await fs.unlink(file);
  assert.deepEqual(await list(member.id, "claude", 2), [], "deleted records are not resurrected by metadata cache");

  const codex = randomUUID();
  await appendCodexTurn({ sessionId: codex, cwd, prompt: "old member Codex conversation", startedAt: 1, events: [] });
  recordOwner(codex, "codex", member.id);
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    await appendCodexTurn({ sessionId: id, cwd, prompt: "newer admin Codex conversation", startedAt: 2, events: [] });
    recordOwner(id, "codex", admin.id);
  }
  assert.deepEqual((await list(member.id, "codex", 1)).map((s: any) => s.sessionId), [codex]);
  assert.deepEqual((await list(member.id, "all", 1)).map((s: any) => s.sessionId), [codex]);
  console.log("sessions-list.test.ts ✓");
} finally { closeDb(); await fs.rm(tmp, { recursive: true, force: true }); }
