// One-time import of the flat JSON stores into SQLite.
//
// Runs at startup, before serving. Each source file is read, inserted inside a
// transaction, then renamed to `<name>.migrated` — so there is never a window
// where both the file and the table are treated as truth, and the original is
// still on disk if something needs checking.
//
// Idempotent: a missing (already-renamed) file is simply skipped.

import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb, transact } from "./db.ts";
import { indexPath } from "./groups/store.ts";
import { legacyCodexIndexPath } from "./session-store.ts";

function ccWebuiDir(): string {
  return path.join(os.homedir(), ".cc-webui");
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A corrupt legacy file must not stop the server from booting — leave it in
    // place (unrenamed) so it can be inspected, and carry on with an empty table.
    console.error(`[cc-webui] sqlite: could not parse ${file}, skipping:`, err);
    return null;
  }
}

async function retire(file: string): Promise<void> {
  await fsp.rename(file, `${file}.migrated`);
}

export async function importLegacyJson(
  opts: {
    recentsFile?: string;
    bindingsFile?: string;
    groupsIndexFile?: string;
    codexIndexFile?: string;
  } = {},
): Promise<{
  recents: number;
  bindings: number;
  groups: number;
  codexSessions: number;
  codexTurns: number;
}> {
  const recentsFile =
    opts.recentsFile ?? path.join(ccWebuiDir(), "recents.json");
  const bindingsFile =
    opts.bindingsFile ?? path.join(ccWebuiDir(), "feishu", "bindings.json");
  // Honours CC_WEBUI_GROUPS_DIR rather than hardcoding the path.
  const groupsIndexFile = opts.groupsIndexFile ?? indexPath();
  const codexIndexFile = opts.codexIndexFile ?? legacyCodexIndexPath();
  const db = getDb();
  const out = {
    recents: 0,
    bindings: 0,
    groups: 0,
    codexSessions: 0,
    codexTurns: 0,
  };

  // recents.json — a bare array of {path, lastUsed}. Owner is "" (unowned)
  // until the permissions module assigns it.
  const recents = await readJson(recentsFile);
  if (Array.isArray(recents)) {
    const stmt = db.prepare(
      `INSERT INTO opened_projects(user_id, path, last_used)
            VALUES ('', ?, ?)
       ON CONFLICT(user_id, path) DO UPDATE
            SET last_used = MAX(last_used, excluded.last_used)`,
    );
    transact(() => {
      for (const r of recents) {
        const p = (r as { path?: unknown }).path;
        const t = (r as { lastUsed?: unknown }).lastUsed;
        if (typeof p === "string" && p) {
          stmt.run(p, typeof t === "number" ? t : 0);
          out.recents++;
        }
      }
    });
    await retire(recentsFile);
  }

  // bindings.json — a flat Record<chatId, gid>.
  const bindings = await readJson(bindingsFile);
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    const stmt = db.prepare(
      `INSERT INTO feishu_bindings(chat_id, gid, updated_at)
            VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET gid = excluded.gid`,
    );
    const now = Date.now();
    transact(() => {
      for (const [chatId, gid] of Object.entries(
        bindings as Record<string, unknown>,
      )) {
        if (typeof gid === "string" && gid) {
          stmt.run(chatId, gid, now);
          out.bindings++;
        }
      }
    });
    await retire(bindingsFile);
  }

  // groups/index.json — {groups:[{id,title,cwd,lastTs,participantSummary,
  // lastSnippet,inFlight}]}. inFlight is dropped: it was never authoritative.
  const groups = await readJson(groupsIndexFile);
  const groupRows = (groups as { groups?: unknown } | null)?.groups;
  if (Array.isArray(groupRows)) {
    const stmt = db.prepare(
      `INSERT INTO groups_index(gid, title, cwd, last_ts, participant_summary, last_snippet)
            VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(gid) DO NOTHING`,
    );
    transact(() => {
      for (const g of groupRows) {
        const r = g as Record<string, unknown>;
        if (typeof r.id !== "string" || !r.id) continue;
        stmt.run(
          r.id,
          typeof r.title === "string" ? r.title : "",
          typeof r.cwd === "string" ? r.cwd : "",
          typeof r.lastTs === "number" ? r.lastTs : 0,
          typeof r.participantSummary === "string" ? r.participantSummary : "",
          typeof r.lastSnippet === "string" ? r.lastSnippet : "",
        );
        out.groups++;
      }
    });
    await retire(groupsIndexFile);
  }

  // sessions.json — {codexSessions:[{sessionId,...,turns:[...]}]}. Summary and
  // turns split into two tables; turn payloads were ~67% of this file.
  const codex = await readJson(codexIndexFile);
  const codexRows = (codex as { codexSessions?: unknown } | null)?.codexSessions;
  if (Array.isArray(codexRows)) {
    const insSession = db.prepare(
      `INSERT INTO codex_sessions(session_id, cwd, summary, first_prompt, custom_title, last_modified)
            VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    );
    const insTurn = db.prepare(
      `INSERT INTO codex_turns(session_id, prompt, started_at, events)
            VALUES (?, ?, ?, ?)`,
    );
    transact(() => {
      for (const row of codexRows) {
        const r = row as Record<string, unknown>;
        const id = r.sessionId;
        if (typeof id !== "string" || !id) continue;
        insSession.run(
          id,
          typeof r.cwd === "string" ? r.cwd : null,
          typeof r.summary === "string" ? r.summary : null,
          typeof r.firstPrompt === "string" ? r.firstPrompt : null,
          typeof r.customTitle === "string" ? r.customTitle : null,
          typeof r.lastModified === "number" ? r.lastModified : 0,
        );
        out.codexSessions++;
        const turns = Array.isArray(r.turns) ? r.turns : [];
        for (const t of turns) {
          const tt = t as Record<string, unknown>;
          insTurn.run(
            id,
            typeof tt.prompt === "string" ? tt.prompt : "",
            typeof tt.startedAt === "number" ? tt.startedAt : 0,
            JSON.stringify(Array.isArray(tt.events) ? tt.events : []),
          );
          out.codexTurns++;
        }
      }
    });
    await retire(codexIndexFile);
  }

  if (
    out.recents ||
    out.bindings ||
    out.groups ||
    out.codexSessions
  ) {
    console.log(
      `[cc-webui] sqlite: imported ${out.recents} recent project(s), ` +
        `${out.bindings} feishu binding(s), ${out.groups} group(s), ` +
        `${out.codexSessions} codex session(s) / ${out.codexTurns} turn(s); ` +
        `originals renamed to *.migrated`,
    );
  }
  return out;
}
