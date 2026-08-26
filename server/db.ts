// The only module that touches a SQLite driver.
//
// Everything else goes through `getDb()` and the typed helpers in the per-store
// modules, so swapping `node:sqlite` for `better-sqlite3` (or anything else)
// means editing this file and nothing more.
//
// Why SQLite at all: every JSON store in this repo is a read-modify-write of a
// whole file (see the old `upsertIndexRow`), which loses updates when two
// writers race. That was rare while cc-webui was single-user; it stops being
// rare the moment there are several. Plus the user/permissions work needs real
// queries ("sessions owned by X, newest 30") and real transactions.
//
// What deliberately does NOT live here — see docs/user-permissions.md:
//   - ~/.claude/projects/<slug>/*.jsonl   Claude Code CLI's own store, shared
//                                         with the user's terminal sessions
//   - ~/.codex/sessions                   Codex's own store
//   - groups/<gid>/transcript.jsonl       append-only canonical truth; jsonl is
//                                         genuinely the right shape for it
// Rule of thumb: the DB holds indexes and relations, files hold content.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// node:sqlite is still flagged experimental and emits a warning on first use.
// Swallow just that one line — the information it carries (the API may change
// across Node releases) is real, so we restate it once at startup instead of
// letting a stack-trace warning fire on every dev restart.
const originalEmitWarning = process.emitWarning.bind(process);
let warnedOnce = false;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const message =
    typeof warning === "string"
      ? warning
      : ((warning as Error | undefined)?.message ?? "");
  if (/SQLite is an experimental feature/i.test(message)) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.log(
        "[cc-webui] sqlite: using node:sqlite (experimental API, isolated in server/db.ts)",
      );
    }
    return;
  }
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { DatabaseSync } = await import("node:sqlite");
type Database = InstanceType<typeof DatabaseSync>;

export function dbPath(): string {
  const env = process.env.CC_WEBUI_DB?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".cc-webui", "cc-webui.db");
}

// ─── Schema ─────────────────────────────────────────────────────────────────
//
// Append-only: never edit a shipped migration, add a new one. `user_version`
// tracks how many have run.
//
// `user_id` is TEXT NOT NULL DEFAULT '' rather than nullable on purpose:
// SQLite treats NULLs as distinct in a UNIQUE index, so a nullable owner would
// silently allow duplicate rows per path. '' means "no owner yet" until the
// permissions module fills it in.
const MIGRATIONS: string[] = [
  // 1 — replaces ~/.cc-webui/recents.json (one shared file, capped at 20, which
  // with several users would simply squeeze everyone else out),
  // ~/.cc-webui/feishu/bindings.json, ~/.cc-webui/groups/index.json (the
  // read-modify-write-whole-file store that loses updates on concurrent turns)
  // and the index half of ~/.cc-webui/sessions.json.
  `
  CREATE TABLE opened_projects (
    user_id   TEXT    NOT NULL DEFAULT '',
    path      TEXT    NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (user_id, path)
  );
  CREATE INDEX idx_opened_projects_recent ON opened_projects(user_id, last_used DESC);

  -- Keyed by chat_id alone, NOT (bot, chat). That is deliberate: in a Feishu
  -- group both @claude and @codex must land on the SAME gid so they can see
  -- each other's replies — that is the whole point of the multi-agent pipeline.
  -- A bot dimension would give each bot its own group in one chat.
  CREATE TABLE feishu_bindings (
    chat_id    TEXT    PRIMARY KEY,
    gid        TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- inFlight is deliberately absent: the old index.json stored it, but every
  -- reader overwrote it from the live in-memory registry (groups.ts:63), so the
  -- persisted value was dead weight.
  CREATE TABLE groups_index (
    gid                 TEXT    PRIMARY KEY,
    title               TEXT    NOT NULL,
    cwd                 TEXT    NOT NULL,
    last_ts             INTEGER NOT NULL,
    participant_summary TEXT    NOT NULL,
    last_snippet        TEXT    NOT NULL
  );
  CREATE INDEX idx_groups_index_recent ON groups_index(last_ts DESC);

  CREATE TABLE codex_sessions (
    session_id    TEXT    PRIMARY KEY,
    cwd           TEXT,
    summary       TEXT,
    first_prompt  TEXT,
    custom_title  TEXT,
    last_modified INTEGER NOT NULL
  );
  CREATE INDEX idx_codex_sessions_recent ON codex_sessions(last_modified DESC);

  -- Codex turn payloads were ~67% of sessions.json. Kept as one row per turn so
  -- reading an index no longer drags the transcripts along.
  CREATE TABLE codex_turns (
    id         INTEGER PRIMARY KEY,
    session_id TEXT    NOT NULL REFERENCES codex_sessions(session_id) ON DELETE CASCADE,
    prompt     TEXT    NOT NULL,
    started_at INTEGER NOT NULL,
    events     TEXT    NOT NULL
  );
  CREATE INDEX idx_codex_turns_session ON codex_turns(session_id, started_at);
  `,

  // 2 — the user/permissions module. See docs/user-permissions.md; note the
  // boundary stated there: the folder whitelist is a guardrail, NOT isolation,
  // because the agent runs as this process's OS user with an unrestricted shell.
  `
  CREATE TABLE users (
    id            TEXT    PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,   -- node:crypto scrypt, hex
    salt          TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin', 'user')),
    created_at    INTEGER NOT NULL
  );

  -- glob patterns fed to path.matchesGlob after realpath normalisation.
  -- No rows for a user = that user may open nothing.
  CREATE TABLE allowed_paths (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    PRIMARY KEY (user_id, pattern)
  );

  -- One table for all three resource kinds: Claude sessionId, Codex threadId
  -- and gid are all UUIDs, so they cannot collide. Ownership lives here rather
  -- than as a column on the session files, because those files belong to the
  -- Claude/Codex CLIs (and are shared with the user's own terminal sessions).
  CREATE TABLE ownership (
    resource_id TEXT    PRIMARY KEY,
    kind        TEXT    NOT NULL CHECK (kind IN ('claude', 'codex', 'group')),
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_ownership_user ON ownership(user_id, kind);

  -- Feishu senders. An unmapped open_id is refused, which also closes the
  -- documented "anyone in the group can @ the bot" hole.
  CREATE TABLE feishu_senders (
    open_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );
  `,

  // 3 — 「本对话文件」registry（docs/file-manager.md）。一条会话的 turn 亲手
  // 创建或改动过的、位于该会话 cwd 之下的文件。
  //
  // 为什么要有它：agent 主要用 mcp__bash__run 写盘，只认 Write/Edit 报告过的
  // 路径会漏掉主路径。所以每个 turn 收尾扫一遍 cwd，mtime >= turnStart 即算
  // 这个 turn 碰过。
  //
  // session_id 不加外键：它是 Claude CLI 发的 session id，不是本库的实体，而且
  // 首个 turn 会被换掉一次（见 relabelSessionFiles）。
  `
  CREATE TABLE session_files (
    session_id      TEXT    NOT NULL,
    path            TEXT    NOT NULL,
    first_seen_ms   INTEGER NOT NULL,
    last_touched_ms INTEGER NOT NULL,
    size            INTEGER NOT NULL DEFAULT 0,
    mtime_ms        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, path)
  );
  CREATE INDEX idx_session_files_recent
    ON session_files(session_id, last_touched_ms DESC);
  `,
];

let handle: Database | null = null;

export function getDb(): Database {
  if (handle) return handle;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // WAL lets readers proceed during a write — the whole point, given SSE
  // handlers read while turns write. busy_timeout covers the brief exclusive
  // moments WAL still needs.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const current = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: number })
      ?.user_version ?? 0,
  );
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    console.log(`[cc-webui] sqlite: applied migration ${i + 1}`);
  }

  handle = db;
  return handle;
}

// Run `fn` inside a transaction. Nested calls reuse the outer one rather than
// failing on SQLite's lack of nested BEGIN.
let depth = 0;
export function transact<T>(fn: () => T): T {
  const db = getDb();
  if (depth > 0) return fn();
  db.exec("BEGIN");
  depth++;
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth--;
  }
}

// Tests only: drop the connection so a fresh CC_WEBUI_DB takes effect.
export function closeDb(): void {
  handle?.close();
  handle = null;
}
