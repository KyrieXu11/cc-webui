import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { getDb } from "../db.ts";
import type { ChatEvent } from "../../src/lib/types.ts";

export type AgentId = "claude" | "codex";

// Re-export ChatEvent so callers don't have to know it lives in src/lib.
export type { ChatEvent } from "../../src/lib/types.ts";

export type ImageAttachment = {
  name?: string;
  mediaType: string;
  data: string;
};

// Each canonical entry wraps a ChatEvent (the same shape the frontend's
// MessageList consumes) plus group-specific metadata: which agent
// produced it, when, and which pipeline step / turnId it belongs to.
export type GroupTurnEntry = {
  agent: "user" | AgentId;
  ts: number;
  event: ChatEvent;
  meta?: {
    turnId?: string;
    pipelineStep?: number;
    recipients?: AgentId[];
    error?: string;
    // User-attached quote-reply context: which agent's prior reply the
    // user is referring to in this message. Rendered as a markdown
    // blockquote when building the prompt and as a styled block above
    // the user bubble in the UI.
    quote?: { agent: AgentId; text: string };
  };
};

export type GroupIndexRow = {
  id: string;
  title: string;
  cwd: string;
  lastTs: number;
  participantSummary: string;
  lastSnippet: string;
  inFlight: boolean;
};

export type GroupIndex = { groups: GroupIndexRow[] };

const HOME_DIR = os.homedir();

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(HOME_DIR, p.slice(2)) : p;
}

export function groupsRoot(): string {
  const env = process.env.CC_WEBUI_GROUPS_DIR;
  if (env) return path.resolve(expandHome(env));
  return path.join(HOME_DIR, ".cc-webui", "groups");
}

export function groupDir(gid: string): string {
  return path.join(groupsRoot(), gid);
}

export function transcriptPath(gid: string): string {
  return path.join(groupDir(gid), "transcript.jsonl");
}

export function configPath(gid: string): string {
  return path.join(groupDir(gid), "config.json");
}

export function indexPath(): string {
  return path.join(groupsRoot(), "index.json");
}

export function newGroupId(): string {
  return randomUUID();
}

export function newEntryId(): string {
  return randomUUID();
}

export async function ensureGroupDir(gid: string): Promise<void> {
  await fs.mkdir(groupDir(gid), { recursive: true });
}

export async function appendEntry(
  gid: string,
  entry: GroupTurnEntry,
): Promise<void> {
  await ensureGroupDir(gid);
  await fs.appendFile(transcriptPath(gid), JSON.stringify(entry) + "\n");
}

export async function readAll(gid: string): Promise<GroupTurnEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath(gid), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: GroupTurnEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as GroupTurnEntry;
      // Skip rows without a recognizable event payload — guards against
      // schema drift from earlier dev iterations.
      if (parsed && parsed.event && parsed.event.type) {
        out.push(parsed);
      }
    } catch {
      // skip corrupted line
    }
  }
  return out;
}

// The group index lives in SQLite (see server/db.ts). It used to be
// index.json, read-modify-written in full on every update — two turns ending
// at once dropped one row's lastTs/lastSnippet. Each function below is a single
// statement, so that race is gone.
//
// `inFlight` is not stored: every reader already overwrote it from the live
// in-memory registry (groups.ts:63), so persisting it was dead weight. It is
// returned as false and callers fill it in.

type IndexDbRow = {
  gid: string;
  title: string;
  cwd: string;
  lastTs: number;
  participantSummary: string;
  lastSnippet: string;
};

const SELECT_INDEX = `SELECT gid, title, cwd,
                             last_ts             AS lastTs,
                             participant_summary AS participantSummary,
                             last_snippet        AS lastSnippet
                        FROM groups_index`;

function toRow(r: IndexDbRow): GroupIndexRow {
  return {
    id: r.gid,
    title: r.title,
    cwd: r.cwd,
    lastTs: r.lastTs,
    participantSummary: r.participantSummary,
    lastSnippet: r.lastSnippet,
    inFlight: false,
  };
}

export async function readIndex(): Promise<GroupIndex> {
  const rows = getDb()
    .prepare(`${SELECT_INDEX} ORDER BY last_ts DESC`)
    .all() as IndexDbRow[];
  return { groups: rows.map(toRow) };
}

export async function upsertIndexRow(row: GroupIndexRow): Promise<void> {
  getDb()
    .prepare(
      `INSERT INTO groups_index(gid, title, cwd, last_ts, participant_summary, last_snippet)
            VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(gid) DO UPDATE SET
            title               = excluded.title,
            cwd                 = excluded.cwd,
            last_ts             = excluded.last_ts,
            participant_summary = excluded.participant_summary,
            last_snippet        = excluded.last_snippet`,
    )
    .run(
      row.id,
      row.title,
      row.cwd,
      row.lastTs,
      row.participantSummary,
      row.lastSnippet,
    );
}

// Update only the descriptive columns, leaving lastTs / lastSnippet as they
// are. Callers used to read the old row and copy those two fields forward by
// hand, which is precisely how a concurrent turn's update got clobbered.
export async function updateIndexMeta(
  gid: string,
  fields: { title: string; cwd: string; participantSummary: string },
): Promise<void> {
  getDb()
    .prepare(
      `UPDATE groups_index
          SET title = ?, cwd = ?, participant_summary = ?
        WHERE gid = ?`,
    )
    .run(fields.title, fields.cwd, fields.participantSummary, gid);
}

export async function removeIndexRow(gid: string): Promise<void> {
  getDb().prepare("DELETE FROM groups_index WHERE gid = ?").run(gid);
}

// Helper: assemble a GroupTurnEntry from a ChatEvent. Centralizes the
// timestamp + meta defaults so callers don't keep them in sync by hand.
export function makeEntry(args: {
  agent: "user" | AgentId;
  event: ChatEvent;
  turnId?: string;
  pipelineStep?: number;
  recipients?: AgentId[];
  error?: string;
}): GroupTurnEntry {
  const meta: GroupTurnEntry["meta"] = {};
  if (args.turnId) meta.turnId = args.turnId;
  if (args.pipelineStep !== undefined) meta.pipelineStep = args.pipelineStep;
  if (args.recipients) meta.recipients = args.recipients;
  if (args.error) meta.error = args.error;
  return {
    agent: args.agent,
    ts: Date.now(),
    event: args.event,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  };
}
