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

  // 4 — 删除留痕。**这不是通用审计日志**：docs/user-permissions.md 的
  // 「明确不做的」里写着「不做审计日志（决策 11 明确选了静默）」，那条不变。
  // 这张表只记一件事——文件删除，因为取件台的删除是**真删、批量、无回收站**，
  // 而这块地既没有 git 也没有快照。不留痕的话「谁删的」永远查不到。
  //
  // username 冗余存一份：账号可以被删掉，而这条记录的全部意义就是**事后**回答
  // 「是谁」，那时候 join users 可能已经 join 不到了。
  `
  CREATE TABLE file_deletions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    username   TEXT    NOT NULL,
    session_id TEXT    NOT NULL DEFAULT '',
    path       TEXT    NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NOT NULL
  );
  CREATE INDEX idx_file_deletions_time ON file_deletions(deleted_at DESC);
  `,

  // 5 — 桌面客户端（docs/desktop-client.md）。两张表，一张记「哪台机器」，
  // 一张记「那台机器上该起哪些 MCP server」。
  //
  // devices 的主键是 user_id 而不是 device_id：这就是决策 5「一账号一设备」
  // 在 schema 层的表达。**故意不放在应用层判断** —— 两个并发连接之间的
  // check-then-insert 正是逼着这个仓库上 SQLite 的那类竞态（见文件头 6-11 行），
  // 也是 AGENTS.md 里群聊 startTurn TOCTOU 那条已知缺陷的同款。
  //
  // 在线状态（已连接 / 已暂停）**故意不落库**，理由和 groups_index 砍掉
  // in_flight 完全一样（见迁移 1 的注释）：WS 注册表是唯一真相，落库值是死重，
  // 而且进程崩了以后库里会留下一堆永远为「已连接」的僵尸行。
  // 这里只放耐久事实：设备身份、给人看的名字、平台、客户端版本、最后一次心跳。
  // db.test.ts 有一条断言把这个判断钉死，别绕过它。
  //
  // last_seen_ms 是耐久的：它回答「这台机器上次出现是什么时候」，
  // 在设备离线时仍然有意义 —— 这和「现在是否连着」是两个问题。
  `
  CREATE TABLE devices (
    user_id        TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    device_id      TEXT    NOT NULL,
    label          TEXT    NOT NULL DEFAULT '',
    platform       TEXT    NOT NULL DEFAULT '',
    client_version TEXT    NOT NULL DEFAULT '',
    last_seen_ms   INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
  );

  -- 决策 16：本地 MCP server 的清单由服务端下发，客户端照单 spawn。
  -- v1 不做管理界面（配置格式头两版几乎肯定要改），所以这张表**没有任何
  -- 自动写入路径** —— 手工 INSERT。因此读侧必须容忍「一行都没有」：
  -- 那表示这个账号没有本地 MCP server，不是错误。
  --
  -- spec 存 JSON 而不是拆成列：一个 server 的启动参数是 {command, args, env,
  -- cwd} 这种嵌套结构，拆列会在第一次要加字段时就变成又一条迁移。
  -- 代价是列名拼错不会报错（见文件头关于 null-prototype 行的说明），
  -- 所以读侧要自己 try/catch —— session-store.ts:473 那个先例没做，别学它。
  CREATE TABLE local_mcp_servers (
    user_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name    TEXT    NOT NULL,
    spec    TEXT    NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, name)
  );
  `,

  // 6 — 会话共享。`ownership` 回答「归谁」，这张表回答「还给谁看过」，
  // 两件事分开而不是往 ownership 里塞第二个 user_id：**一个资源只能有一个
  // owner，但可以共享给任意多人**，塞进去第一天就要拆。
  //
  // ⚠️ 共享**不是**所有权。读得到 ≠ 删得掉：policy 里只有显式标了
  // `access: "reader"` 的路由认这张表，DELETE / PATCH 那些仍然只认 owner。
  // 这个区分是本迁移的全部意义，改动前先读 server/auth/policy.ts 的 OwnsSpec。
  //
  // resource_id 不加外键指向 ownership：**无主资源也可以被共享**（孤儿会话按
  // 决策 10 是管理员可见的，他应当能把其中一条转手给家人），而那种资源在
  // ownership 里根本没有行。
  //
  // shared_by 只为「谁共享给我的」这句 UI 文案存在，不参与任何鉴权判断 ——
  // 判断只看 (resource_id, user_id) 在不在。所以它没有外键：共享者的账号被
  // 删掉之后，这条共享**依然有效**（被共享者不该因为别人离职就丢掉手里的会话），
  // 只是署名会退化成一个查不到的 id，读侧按「未知」渲染。
  `
  CREATE TABLE shares (
    resource_id TEXT    NOT NULL,
    user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL CHECK (kind IN ('claude', 'codex', 'group')),
    shared_by   TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (resource_id, user_id)
  );
  CREATE INDEX idx_shares_user ON shares(user_id);
  `,

  // 7 — 管理员给账号设的默认模型 / effort（docs/user-permissions.md 决策 45-47）。
  //
  // ⚠️ 是**默认值，不是限制**：服务端没有任何地方拿它去覆盖请求里的 model /
  // effort。它只随 /api/auth/me 下发，浏览器看到 updated_at 和自己上次套用的
  // 不一样时套用一次，之后用户自己改的照样保留。
  //
  // 没有行 = 没设。「两列都清空」直接删行，所以「没设」只有一种写法。
  `
  CREATE TABLE user_defaults (
    user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    model      TEXT,
    effort     TEXT,
    updated_at INTEGER NOT NULL
  );
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
