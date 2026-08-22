import fs from "node:fs/promises";
import os from "node:os";
import { getDb, transact } from "./db.ts";
import path from "node:path";

export type AgentProvider = "claude" | "codex";

export interface SessionSummary {
  sessionId: string;
  provider: AgentProvider;
  summary: string;
  lastModified: number;
  cwd?: string;
  firstPrompt?: string;
  customTitle?: string;
}

export interface CodexStoredTurn {
  provider: "codex";
  prompt: string;
  startedAt: number;
  events: unknown[];
}

interface NativeCodexSession extends SessionSummary {
  provider: "codex";
  filePath: string;
}

type CodexRolloutRecord = {
  timestamp?: string;
  type?: string;
  payload?: any;
};

// Legacy location of cc-webui's Codex index, now only read once by
// server/import-legacy-json.ts.
export function legacyCodexIndexPath(): string {
  return (
    process.env.CC_WEBUI_SESSION_INDEX ||
    path.join(os.homedir(), ".cc-webui", "sessions.json")
  );
}
const CODEX_SESSIONS_DIR =
  process.env.CODEX_SESSIONS_DIR ||
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");

const CODEX_SESSION_ID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function summarizePrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? compact.slice(0, 79) + "..." : compact;
}

function compactText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const block = item as Record<string, unknown>;
        if (typeof block.text === "string") return block.text;
        if (typeof block.output_text === "string") return block.output_text;
        if (typeof block.content === "string") return block.content;
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return compactText(obj.text);
    if (typeof obj.message === "string") return compactText(obj.message);
    if (typeof obj.content === "string" || Array.isArray(obj.content)) {
      return compactText(obj.content);
    }
  }
  return "";
}

function timestampMs(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

function sessionIdFromPath(filePath: string): string | undefined {
  return path.basename(filePath).match(CODEX_SESSION_ID_RE)?.[1];
}

function publicSummary(s: NativeCodexSession): SessionSummary {
  const { filePath: _filePath, ...summary } = s;
  return summary;
}

function parseJsonLine(line: string): CodexRolloutRecord | null {
  try {
    return JSON.parse(line) as CodexRolloutRecord;
  } catch {
    return null;
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(abs)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(abs);
    }
  }
  return files;
}

async function parseNativeCodexSummary(
  filePath: string
): Promise<NativeCodexSession | null> {
  let raw: string;
  let stat;
  try {
    [raw, stat] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      fs.stat(filePath),
    ]);
  } catch {
    return null;
  }

  let sessionId = sessionIdFromPath(filePath);
  let cwd: string | undefined;
  let firstPrompt = "";
  let fallbackPrompt = "";
  let customTitle: string | undefined;
  let lastModified = stat.mtimeMs;

  for (const line of raw.split(/\n/)) {
    if (!line.trim()) continue;
    const record = parseJsonLine(line);
    if (!record) continue;

    const ts = timestampMs(record.timestamp);
    if (ts && ts > lastModified) lastModified = ts;

    const payload = record.payload ?? {};
    if (record.type === "session_meta") {
      if (typeof payload.id === "string") sessionId = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
    } else if (record.type === "turn_context") {
      if (typeof payload.cwd === "string") cwd = payload.cwd;
    } else if (record.type === "event_msg") {
      if (payload.type === "user_message" && !firstPrompt) {
        firstPrompt = compactText(payload.message);
      } else if (
        payload.type === "thread_name_updated" &&
        typeof payload.thread_name === "string"
      ) {
        customTitle = summarizePrompt(payload.thread_name);
      }
    } else if (
      record.type === "response_item" &&
      payload.role === "user" &&
      !fallbackPrompt
    ) {
      fallbackPrompt = compactText(payload.content);
    }
  }

  if (!sessionId) return null;
  if (!firstPrompt) firstPrompt = fallbackPrompt;
  const summary = summarizePrompt(firstPrompt) || customTitle || "Codex conversation";
  return {
    sessionId,
    provider: "codex",
    summary,
    firstPrompt: firstPrompt || undefined,
    customTitle,
    cwd,
    lastModified,
    filePath,
  };
}

async function listNativeCodexSessions(): Promise<NativeCodexSession[]> {
  const files = await listJsonlFiles(CODEX_SESSIONS_DIR);
  const sessions = await Promise.all(files.map(parseNativeCodexSummary));
  return sessions.filter((s): s is NativeCodexSession => Boolean(s));
}

async function findNativeCodexSessionFile(
  sessionId: string
): Promise<string | null> {
  const files = await listJsonlFiles(CODEX_SESSIONS_DIR);
  const direct = files.find((file) => sessionIdFromPath(file) === sessionId);
  if (direct) return direct;

  for (const file of files) {
    const summary = await parseNativeCodexSummary(file);
    if (summary?.sessionId === sessionId) return file;
  }
  return null;
}

function truncateTranscriptText(text: string, max = 12000): string {
  return text.length > max ? text.slice(0, max) + "\n...[truncated]" : text;
}

function commandText(command: unknown): string {
  if (Array.isArray(command)) {
    return command.map((part) => String(part)).join(" ");
  }
  return typeof command === "string" ? command : "";
}

function ensureNativeTurn(
  turns: CodexStoredTurn[],
  current: CodexStoredTurn | null,
  startedAt: number
): CodexStoredTurn {
  if (current) return current;
  const next: CodexStoredTurn = {
    provider: "codex",
    prompt: "",
    startedAt,
    events: [],
  };
  turns.push(next);
  return next;
}

async function readNativeCodexTurns(
  filePath: string
): Promise<CodexStoredTurn[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const turns: CodexStoredTurn[] = [];
  let current: CodexStoredTurn | null = null;
  let seq = 0;
  let lastAgentText = "";

  const pushCurrent = () => {
    if (!current) return;
    if (!current.prompt.trim() && current.events.length === 0) {
      turns.pop();
    }
    current = null;
    lastAgentText = "";
  };

  for (const line of raw.split(/\n/)) {
    if (!line.trim()) continue;
    const record = parseJsonLine(line);
    if (!record?.payload || record.type !== "event_msg") continue;

    const payload = record.payload;
    const startedAt = timestampMs(record.timestamp) ?? Date.now();

    if (payload.type === "user_message") {
      pushCurrent();
      current = {
        provider: "codex",
        prompt: compactText(payload.message),
        startedAt,
        events: [],
      };
      turns.push(current);
      continue;
    }

    const turn = ensureNativeTurn(turns, current, startedAt);
    current = turn;

    if (payload.type === "agent_message") {
      const text = compactText(payload.message);
      if (!text || text === lastAgentText) continue;
      lastAgentText = text;
      turn.events.push({
        type: "item.completed",
        item: {
          id: `native-agent-${seq++}`,
          type: "agent_message",
          text,
        },
      });
    } else if (payload.type === "exec_command_end") {
      turn.events.push({
        type: "item.completed",
        item: {
          id: `native-command-${payload.call_id ?? seq++}`,
          type: "command_execution",
          command: commandText(payload.command),
          status: payload.exit_code === 0 ? "completed" : "failed",
          aggregated_output: truncateTranscriptText(
            compactText(payload.aggregated_output) ||
              compactText(payload.stdout) ||
              compactText(payload.stderr)
          ),
        },
      });
    } else if (payload.type === "patch_apply_end") {
      const changes = Object.entries(payload.changes ?? {}).map(
        ([file, change]) => ({
          file,
          ...(change && typeof change === "object" ? change : {}),
        })
      );
      turn.events.push({
        type: "item.completed",
        item: {
          id: `native-patch-${payload.call_id ?? seq++}`,
          type: "file_change",
          status: payload.success === false ? "failed" : "completed",
          changes,
        },
      });
    } else if (payload.type === "mcp_tool_call_end") {
      const invocation = payload.invocation ?? {};
      turn.events.push({
        type: "item.completed",
        item: {
          id: `native-mcp-${payload.call_id ?? seq++}`,
          type: "mcp_tool_call",
          server: invocation.server,
          tool: invocation.tool,
          arguments: invocation.arguments,
          status: payload.result?.Err ? "failed" : "completed",
          result: payload.result,
        },
      });
    } else if (payload.type === "web_search_end") {
      turn.events.push({
        type: "item.completed",
        item: {
          id: `native-web-${payload.call_id ?? seq++}`,
          type: "web_search",
          query: payload.query,
        },
      });
    } else if (payload.type === "error") {
      turn.events.push({
        type: "item.completed",
        item: {
          id: `native-error-${seq++}`,
          type: "error",
          message: payload.message,
        },
      });
    }
  }

  pushCurrent();
  return turns;
}

// cc-webui's own Codex index lives in SQLite (see server/db.ts). It used to be
// ~/.cc-webui/sessions.json, where turn payloads were ~67% of the bytes — so
// listing summaries dragged every transcript along. Now they are separate
// tables and the list query never touches codex_turns.
//
// The NATIVE Codex store (~/.codex/sessions) is untouched: it is Codex's own
// format, we only read it. Merging the two is unchanged, below.

type StoredSummaryRow = {
  sessionId: string;
  cwd: string | null;
  summary: string | null;
  firstPrompt: string | null;
  customTitle: string | null;
  lastModified: number;
};

function listStoredCodexSummaries(): SessionSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id    AS sessionId,
              cwd,
              summary,
              first_prompt  AS firstPrompt,
              custom_title  AS customTitle,
              last_modified AS lastModified
         FROM codex_sessions`,
    )
    .all() as StoredSummaryRow[];
  return rows.map((r) => ({
    sessionId: r.sessionId,
    provider: "codex" as const,
    summary: r.summary ?? "",
    lastModified: r.lastModified,
    cwd: r.cwd ?? undefined,
    firstPrompt: r.firstPrompt ?? undefined,
    customTitle: r.customTitle ?? undefined,
  }));
}

export async function listCodexSessions(opts: {
  limit: number;
  cwd?: string;
}): Promise<SessionSummary[]> {
  const nativeSessions = await listNativeCodexSessions();
  const stored = listStoredCodexSummaries();
  const byId = new Map<string, SessionSummary>();

  for (const native of nativeSessions) {
    byId.set(native.sessionId, publicSummary(native));
  }

  for (const storedSummary of stored) {
    const existing = byId.get(storedSummary.sessionId);
    byId.set(storedSummary.sessionId, {
      ...existing,
      ...storedSummary,
      provider: "codex",
      cwd: storedSummary.cwd ?? existing?.cwd,
      firstPrompt: storedSummary.firstPrompt ?? existing?.firstPrompt,
      customTitle: storedSummary.customTitle ?? existing?.customTitle,
      summary: storedSummary.summary || existing?.summary || "Codex conversation",
      lastModified: Math.max(
        storedSummary.lastModified ?? 0,
        existing?.lastModified ?? 0
      ),
    });
  }

  return Array.from(byId.values())
    .filter((s) => !opts.cwd || s.cwd === opts.cwd)
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, opts.limit);
}

export async function getCodexSessionTurns(
  sessionId: string
): Promise<CodexStoredTurn[]> {
  const nativeFile = await findNativeCodexSessionFile(sessionId);
  if (nativeFile) {
    const nativeTurns = await readNativeCodexTurns(nativeFile);
    if (nativeTurns.length > 0) return nativeTurns;
  }

  const rows = getDb()
    .prepare(
      `SELECT prompt, started_at AS startedAt, events
         FROM codex_turns
        WHERE session_id = ?
        ORDER BY started_at, id`,
    )
    .all(sessionId) as Array<{
    prompt: string;
    startedAt: number;
    events: string;
  }>;
  return rows.map((r) => ({
    provider: "codex" as const,
    prompt: r.prompt,
    startedAt: r.startedAt,
    events: JSON.parse(r.events) as unknown[],
  }));
}

export async function appendCodexTurn(opts: {
  sessionId: string;
  cwd?: string;
  prompt: string;
  startedAt: number;
  events: unknown[];
}): Promise<void> {
  const now = Date.now();
  const db = getDb();
  // Session upsert + turn insert in one transaction, so a crash between them
  // cannot leave a turn attached to a session row that was never written.
  //
  // COALESCE(NULLIF(col,''), excluded.col) reproduces the old
  // `session.summary = session.summary || …` semantics: first value wins,
  // later turns do not overwrite it.
  transact(() => {
    db.prepare(
      `INSERT INTO codex_sessions(session_id, cwd, summary, first_prompt, last_modified)
            VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
            cwd           = COALESCE(excluded.cwd, cwd),
            summary       = COALESCE(NULLIF(summary, ''), excluded.summary),
            first_prompt  = COALESCE(NULLIF(first_prompt, ''), excluded.first_prompt),
            last_modified = excluded.last_modified`,
    ).run(
      opts.sessionId,
      opts.cwd ?? null,
      summarizePrompt(opts.prompt) || "Codex conversation",
      opts.prompt,
      now,
    );
    db.prepare(
      `INSERT INTO codex_turns(session_id, prompt, started_at, events)
            VALUES (?, ?, ?, ?)`,
    ).run(
      opts.sessionId,
      opts.prompt,
      opts.startedAt,
      JSON.stringify(opts.events),
    );
  });
}

export async function deleteCodexSession(sessionId: string): Promise<boolean> {
  // codex_turns has ON DELETE CASCADE, so the transcripts go with it.
  const res = getDb()
    .prepare("DELETE FROM codex_sessions WHERE session_id = ?")
    .run(sessionId);
  const removedStored = Number(res.changes) > 0;

  const nativeFile = await findNativeCodexSessionFile(sessionId);
  if (!nativeFile) return removedStored;
  try {
    await fs.unlink(nativeFile);
    return true;
  } catch {
    return removedStored;
  }
}
