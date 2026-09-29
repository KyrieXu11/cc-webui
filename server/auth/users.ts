// The user table, plus the first-admin bootstrap.
//
// Roles are just 'admin' | 'user'. What an admin may do is enumerated in
// docs/user-permissions.md (decision 11): see and stop anyone's running turn,
// see anyone's bash tasks, and read anyone's session content — the last one
// deliberately without an access log.

import type { AgentProvider } from "../../src/lib/settings.ts";
import { randomUUID } from "node:crypto";
import { getDb, transact } from "../db.ts";
import { assertUsableUsername, isUsableUsername } from "./workspaces.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";
import { claimUnowned } from "./ownership.ts";

export type Role = "admin" | "user";

export type User = {
  id: string;
  username: string;
  role: Role;
  createdAt: number;
};

type UserRow = User & { passwordHash: string; salt: string };

const SELECT_USER = `SELECT id, username, role,
                            created_at    AS createdAt,
                            password_hash AS passwordHash,
                            salt
                       FROM users`;

function publicUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    createdAt: r.createdAt,
  };
}

export function countUsers(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
  ).n;
}

export function getUserById(id: string): User | null {
  const row = getDb()
    .prepare(`${SELECT_USER} WHERE id = ?`)
    .get(id) as UserRow | undefined;
  return row ? publicUser(row) : null;
}

export function getUserByUsername(username: string): User | null {
  const row = getDb()
    .prepare(`${SELECT_USER} WHERE username = ?`)
    .get(username) as UserRow | undefined;
  return row ? publicUser(row) : null;
}

export function listUsers(): User[] {
  return (
    getDb()
      .prepare(`${SELECT_USER} ORDER BY created_at`)
      .all() as UserRow[]
  ).map(publicUser);
}

export function createUser(opts: {
  username: string;
  password: string;
  role: Role;
  allowedPaths?: string[];
}): User {
  // A username becomes a directory name (server/auth/workspaces.ts), and an
  // admin can be demoted later — so even an account that gets no workspace
  // today needs a name that can become one. Enforced here rather than in the
  // route so the env seed goes through the same gate.
  assertUsableUsername(opts.username);
  const { hash, salt } = hashPassword(opts.password);
  const id = randomUUID();
  const now = Date.now();
  const db = getDb();
  return transact(() => {
    db.prepare(
      `INSERT INTO users(id, username, password_hash, salt, role, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, opts.username, hash, salt, opts.role, now);
    setAllowedPaths(id, opts.allowedPaths ?? []);
    return { id, username: opts.username, role: opts.role, createdAt: now };
  });
}

export function setPassword(userId: string, password: string): void {
  const { hash, salt } = hashPassword(password);
  getDb()
    .prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?")
    .run(hash, salt, userId);
}

export function setRole(userId: string, role: Role): void {
  getDb().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
}

export function deleteUser(userId: string): boolean {
  // allowed_paths / ownership / feishu_senders cascade.
  const res = getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
  return Number(res.changes) > 0;
}

// Returns the user on success, null on either a missing account or a bad
// password — callers must not distinguish the two in what they tell the client.
export function authenticate(username: string, password: string): User | null {
  const row = getDb()
    .prepare(`${SELECT_USER} WHERE username = ?`)
    .get(username) as UserRow | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.passwordHash, row.salt)) return null;
  return publicUser(row);
}

// ─── allowed paths ──────────────────────────────────────────────────────────

export function getAllowedPaths(userId: string): string[] {
  return (
    getDb()
      .prepare("SELECT pattern FROM allowed_paths WHERE user_id = ? ORDER BY pattern")
      .all(userId) as Array<{ pattern: string }>
  ).map((r) => r.pattern);
}

export function setAllowedPaths(userId: string, patterns: string[]): void {
  const db = getDb();
  transact(() => {
    db.prepare("DELETE FROM allowed_paths WHERE user_id = ?").run(userId);
    const ins = db.prepare(
      "INSERT INTO allowed_paths(user_id, pattern) VALUES (?, ?) ON CONFLICT DO NOTHING",
    );
    for (const p of patterns) {
      const trimmed = p.trim();
      if (trimmed) ins.run(userId, trimmed);
    }
  });
}

// ─── defaults ───────────────────────────────────────────────────────────────
//
// The model / effort an admin picked for this account (decisions 45-47). A
// default, not a limit: nothing on the server reads these to override a
// request. The browser applies them once per `updatedAt`, and whatever the
// user changes afterwards sticks until the admin saves again.

export type UserDefaults = {
  provider?: AgentProvider | null;
  model: string | null;
  effort: string | null;
  updatedAt: number;
};

export function getUserDefaults(userId: string): UserDefaults | null {
  const row = getDb()
    .prepare(
      `SELECT provider, model, effort, updated_at AS updatedAt
         FROM user_defaults WHERE user_id = ?`,
    )
    .get(userId) as UserDefaults | undefined;
  if (!row) return null;
  return {
    ...(row.provider ? { provider: row.provider } : {}),
    model: row.model ?? null,
    effort: row.effort ?? null,
    updatedAt: Number(row.updatedAt),
  };
}

// Both null deletes the row, so "not set" has exactly one representation.
// Saving always moves `updatedAt`, which is what makes every browser of that
// account apply it again — including a re-save of the same values.
export function setUserDefaults(
  userId: string,
  value: { provider?: AgentProvider | null; model: string | null; effort: string | null },
): UserDefaults | null {
  const db = getDb();
  if (!value.provider && !value.model && !value.effort) {
    db.prepare("DELETE FROM user_defaults WHERE user_id = ?").run(userId);
    return null;
  }
  // Strictly increasing per account, even for two saves inside one
  // millisecond: an equal stamp would read as "already applied".
  const prev = getUserDefaults(userId)?.updatedAt ?? 0;
  const updatedAt = Math.max(Date.now(), prev + 1);
  db.prepare(
    `INSERT INTO user_defaults(user_id, model, effort, updated_at, provider)
          VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE
        SET provider = excluded.provider,
            model = excluded.model,
            effort = excluded.effort,
            updated_at = excluded.updated_at`,
  ).run(userId, value.model, value.effort, updatedAt, value.provider ?? null);
  return getUserDefaults(userId);
}

// No explicit grant preserves existing ordinary-account behavior. Admins retain both.
export function getAllowedProviders(user: User): AgentProvider[] {
  if (user.role === "admin") return ["claude", "codex"];
  const row = getDb().prepare("SELECT providers FROM user_ai_access WHERE user_id = ?").get(user.id) as { providers: string } | undefined;
  if (!row) return ["claude"];
  try {
    const values: unknown = JSON.parse(row.providers);
    return Array.isArray(values) ? ["claude", "codex"].filter(p => values.includes(p)) as AgentProvider[] : [];
  } catch { return []; }
}

export function assertProviderAllowed(actorId: string | undefined, provider: AgentProvider, mode?: string): void {
  const actor = actorId ? getUserById(actorId) : null;
  if (!actor || !getAllowedProviders(actor).includes(provider)) throw new Error(`此账号不能使用 ${provider}`);
  if (mode === "bypassPermissions" && actor.role !== "admin") throw new Error("Bypass 模式仅管理员可用");
}

export function setAllowedProviders(userId: string, providers: AgentProvider[]): void {
  if (!providers.length || providers.some(p => p !== "claude" && p !== "codex")) throw new Error("at least one valid provider required");
  getDb().prepare(`INSERT INTO user_ai_access(user_id, providers) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET providers = excluded.providers`).run(userId, JSON.stringify([...new Set(providers)]));
}

// ─── bootstrap ──────────────────────────────────────────────────────────────

// CC_WEBUI_ADMIN=user:pass seeds the first admin. Only ever creates — never
// updates an existing account, so leaving the variable set is harmless (and the
// log line says it can be removed).
//
// Note the window this leaves: until the first admin exists, anyone who can
// reach the port could become one via the same path. The port binds to loopback
// by default, but "create the admin before exposing it" is documented.
export function seedAdminFromEnv(raw = process.env.CC_WEBUI_ADMIN): User | null {
  const spec = raw?.trim();
  if (!spec) return null;
  const sep = spec.indexOf(":");
  if (sep <= 0 || sep === spec.length - 1) {
    console.error(
      "[cc-webui] auth: CC_WEBUI_ADMIN must look like user:password — ignoring",
    );
    return null;
  }
  const username = spec.slice(0, sep).trim();
  const password = spec.slice(sep + 1);
  if (getUserByUsername(username)) return null;

  // Same shape of complaint as the malformed-spec case above: log and skip, do
  // not throw. This runs at boot under launchd KeepAlive, so an exception here
  // is not "fail loud" — it is a restart loop every 10 seconds.
  if (!isUsableUsername(username)) {
    console.error(
      `[cc-webui] auth: CC_WEBUI_ADMIN username ${JSON.stringify(username)} is not usable ` +
        "(lowercase letters, digits, - and _ only) — ignoring",
    );
    return null;
  }

  // The admin may open anything; a plain user starts with nothing until an
  // admin grants patterns (decision: default-closed), beyond the workspace they
  // are given at creation (decision 24).
  const user = createUser({
    username,
    password,
    role: "admin",
    allowedPaths: ["**"],
  });
  // Decision 15: everything that predates accounts belongs to this admin.
  const claimed = claimUnowned(user.id);
  console.log(
    `[cc-webui] auth: seeded admin "${username}" from CC_WEBUI_ADMIN ` +
      "(the variable can be removed now); claimed " +
      `${claimed.projects} project(s), ${claimed.groups} group(s), ` +
      `${claimed.codexSessions} codex session(s)`,
  );
  return user;
}
