import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-db-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "nested", "test.db");

const { getDb, closeDb, transact, dbPath } = await import("./db.ts");

try {
  // ── opens, creates parent dirs, applies migrations ───────────────────────

  assert.equal(dbPath(), path.join(tmp, "nested", "test.db"));
  const db = getDb();
  const version = () =>
    Number(
      (db.prepare("PRAGMA user_version").get() as { user_version?: number })
        ?.user_version ?? 0,
    );
  assert.ok(version() >= 1, "migrations must have run");
  assert.equal(getDb(), db, "getDb must be a singleton");

  const mode = db.prepare("PRAGMA journal_mode").get() as {
    journal_mode?: string;
  };
  assert.equal(mode.journal_mode, "wal", "WAL is why readers can run during a write");

  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  for (const t of [
    "codex_sessions",
    "codex_turns",
    "devices",
    "feishu_bindings",
    "groups_index",
    "local_mcp_servers",
    "opened_projects",
  ]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  // inFlight was dead weight in the old index.json — every reader overwrote it.
  const cols = (
    db.prepare("PRAGMA table_info(groups_index)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(!cols.includes("in_flight"), "in_flight must not be persisted");

  // Same judgement, second table: a device's "connected" / "paused" state is
  // exactly the same kind of thing as in_flight was — the live registry
  // (server/devices/registry.ts) is the only truth, and a persisted copy would
  // survive a crash as a row claiming a device is connected forever.
  // `devices` therefore holds durable facts only: identity, label, platform,
  // client version, and when this machine was last seen at all.
  const deviceCols = (
    db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const forbidden of ["connected", "online", "paused"]) {
    assert.ok(
      !deviceCols.includes(forbidden),
      `${forbidden} must not be persisted — the WS registry is the only truth`,
    );
  }
  // One device per account (decision 5) lives in the SCHEMA, not in an
  // application-level check: two concurrent connections racing a
  // check-then-insert is the very class of bug that pushed this repo onto
  // SQLite in the first place (see server/db.ts header).
  const devicePk = (
    db.prepare("PRAGMA table_info(devices)").all() as Array<{
      name: string;
      pk: number;
    }>
  ).filter((c) => Number(c.pk) > 0);
  assert.deepEqual(
    devicePk.map((c) => c.name),
    ["user_id"],
    "devices must be keyed by user_id alone — that IS the one-device-per-account rule",
  );

  // ── reopening is idempotent (migrations must not re-run) ─────────────────

  const before = version();
  closeDb();
  const db2 = getDb();
  assert.equal(
    Number(
      (db2.prepare("PRAGMA user_version").get() as { user_version?: number })
        ?.user_version ?? 0,
    ),
    before,
    "reopen must not bump user_version",
  );

  // ── the '' owner sentinel keeps (user_id, path) genuinely unique ─────────
  //
  // A nullable owner would not: SQLite treats NULLs as distinct in a UNIQUE
  // index, so two unowned rows for the same path would both be allowed.

  const ins = db2.prepare(
    "INSERT INTO opened_projects(user_id, path, last_used) VALUES (?, ?, ?)",
  );
  ins.run("", "/tmp/a", 1);
  assert.throws(
    () => ins.run("", "/tmp/a", 2),
    /UNIQUE|constraint/i,
    "duplicate (owner, path) must be rejected",
  );
  ins.run("u1", "/tmp/a", 3); // same path, different owner → fine
  assert.equal(
    (
      db2
        .prepare("SELECT COUNT(*) AS n FROM opened_projects WHERE path = ?")
        .get("/tmp/a") as { n: number }
    ).n,
    2,
  );

  // ── transact: commits, rolls back, and nests without a nested BEGIN ──────

  transact(() => {
    ins.run("u2", "/tmp/committed", 1);
  });
  assert.ok(
    db2
      .prepare("SELECT 1 FROM opened_projects WHERE path = ?")
      .get("/tmp/committed"),
  );

  assert.throws(() =>
    transact(() => {
      ins.run("u3", "/tmp/rolled-back", 1);
      throw new Error("boom");
    }),
  );
  assert.equal(
    db2
      .prepare("SELECT 1 FROM opened_projects WHERE path = ?")
      .get("/tmp/rolled-back"),
    undefined,
    "a throwing transaction must leave nothing behind",
  );

  const nested = transact(() => transact(() => 42));
  assert.equal(nested, 42, "nested transact must reuse the outer transaction");

  // Foreign keys are on, so an orphan turn is refused.
  assert.throws(
    () =>
      db2
        .prepare(
          "INSERT INTO codex_turns(session_id, prompt, started_at, events) VALUES (?,?,?,?)",
        )
        .run("no-such-session", "p", 1, "[]"),
    /FOREIGN KEY|constraint/i,
  );

  console.log("db.test.ts: all assertions passed");
} finally {
  closeDb();
  delete process.env.CC_WEBUI_DB;
  await fs.rm(tmp, { recursive: true, force: true });
}
