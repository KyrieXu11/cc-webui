import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
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

export async function readIndex(): Promise<GroupIndex> {
  try {
    const raw = await fs.readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<GroupIndex>;
    return { groups: Array.isArray(parsed?.groups) ? parsed.groups : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { groups: [] };
    }
    throw err;
  }
}

export async function writeIndex(idx: GroupIndex): Promise<void> {
  await fs.mkdir(groupsRoot(), { recursive: true });
  const tmp = indexPath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2));
  await fs.rename(tmp, indexPath());
}

export async function upsertIndexRow(row: GroupIndexRow): Promise<void> {
  const idx = await readIndex();
  const i = idx.groups.findIndex((g) => g.id === row.id);
  if (i >= 0) idx.groups[i] = row;
  else idx.groups.push(row);
  await writeIndex(idx);
}

export async function removeIndexRow(gid: string): Promise<void> {
  const idx = await readIndex();
  idx.groups = idx.groups.filter((g) => g.id !== gid);
  await writeIndex(idx);
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
