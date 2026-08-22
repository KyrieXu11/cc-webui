// Reader for Claude Code's native session files, replacing the
// `listSessions` / `getSessionMessages` / `deleteSession` helpers that came
// from @anthropic-ai/claude-agent-sdk. The CLI has no equivalent commands, so
// dropping the SDK means owning this. Mirrors the Codex-side reader in
// server/session-store.ts.
//
// Layout: ~/.claude/projects/<slug>/<sessionId>.jsonl, append-only, one JSON
// object per line. cc-webui only ever reads (and deletes whole sessions).

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionSummary } from "./session-store.ts";

// Overridable for tests, mirroring CODEX_SESSIONS_DIR / CC_WEBUI_GROUPS_DIR.
export function projectsDir(): string {
  const env = process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".claude", "projects");
}

// cwd → project directory name.
//
// Derived empirically against 706 real directories on disk: every non
// [A-Za-z0-9-] character becomes "-". 705 matched exactly; the one exception
// was a directory carrying an extra name suffix its sessions' `cwd` does not
// have, not a rule violation.
//
// ⚠️ Lossy and therefore NOT invertible — a CJK path collapses to a run of
// dashes. Always go cwd → slug, never slug → cwd; when the real cwd is needed,
// read it off a line inside the file.
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

// The SDK rejected non-UUID session ids before touching the filesystem, which
// is also what keeps `id` from escaping the projects directory. Keep it.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

export type ClaudeSessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  timestamp?: string;
  parent_tool_use_id: string | null;
};

// Everything else on a line is bookkeeping cc-webui does not render
// (queue-operation, attachment, last-prompt, operation, ai-title, …).
const MESSAGE_TYPES = new Set(["user", "assistant", "system"]);

// Slash-command plumbing the CLI writes into the transcript as user turns.
// The SDK hid these; showing them would put raw `<command-message>` XML in the
// history as if the user had typed it.
const ECHO_PREFIXES = [
  "<command-message>",
  "<command-name>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<command-args>",
];

type RawLine = {
  type?: unknown;
  sessionId?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  message?: unknown;
  cwd?: unknown;
  isMeta?: unknown;
  parentToolUseId?: unknown;
  aiTitle?: unknown;
};

// Which lines the SDK's reader hid, established by diffing this reader against
// it over a real 600-message transcript:
//   - `isMeta: true`      — caveats, skill preambles, injected context
//   - slash-command echo  — a user turn whose text is only the command wrapper
// System-injected user turns. The SDK KEEPS these in the message history — so
// they are not hidden — but they must not become a session's `firstPrompt`,
// which feeds the sidebar fallback label and the header search index.
const INJECTED_PREFIXES = [
  "<task-notification>",
  "<system-reminder>",
  "<cross-session-message",
];

export function isInjectedUserLine(o: RawLine): boolean {
  if (o.type !== "user") return false;
  const text = firstUserText(o.message).trimStart();
  return INJECTED_PREFIXES.some((p) => text.startsWith(p));
}

export function isHiddenUserLine(o: RawLine): boolean {
  if (o.isMeta === true) return true;
  if (o.type !== "user") return false;
  const text = firstUserText(o.message).trimStart();
  return ECHO_PREFIXES.some((p) => text.startsWith(p));
}

function parseLine(line: string): RawLine | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    return o && typeof o === "object" ? (o as RawLine) : null;
  } catch {
    // A partially-flushed final line is normal for an append-only file.
    return null;
  }
}

function toMessage(o: RawLine): ClaudeSessionMessage | null {
  if (typeof o.type !== "string" || !MESSAGE_TYPES.has(o.type)) return null;
  if (o.message === undefined) return null;
  if (isHiddenUserLine(o)) return null;
  return {
    parent_tool_use_id:
      typeof o.parentToolUseId === "string" ? o.parentToolUseId : null,
    type: o.type as ClaudeSessionMessage["type"],
    uuid: typeof o.uuid === "string" ? o.uuid : "",
    // The on-disk field is camelCase; the frontend's SessionMessage expects
    // snake_case, same as live SDK/CLI events.
    session_id: typeof o.sessionId === "string" ? o.sessionId : "",
    message: o.message,
    timestamp: typeof o.timestamp === "string" ? o.timestamp : undefined,
  };
}

function summarize(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? compact.slice(0, 79) + "..." : compact;
}

function firstUserText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""
    )
    .join(" ");
}

async function listJsonl(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// Scan every project directory for <id>.jsonl. readdir only — no file reads —
// so this stays cheap even with hundreds of sessions.
async function findSessionFile(
  id: string,
  dir?: string
): Promise<string | null> {
  if (!isSessionId(id)) return null;
  const root = projectsDir();
  if (dir) {
    const direct = path.join(root, projectSlug(dir), `${id}.jsonl`);
    try {
      await fs.access(direct);
      return direct;
    } catch {
      /* fall through to the scan */
    }
  }
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const name of entries) {
    const candidate = path.join(root, name, `${id}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// Enough of the head to find the first user prompt without reading a
// multi-megabyte transcript.
const HEAD_BYTES = 256 * 1024;

async function summaryFor(
  file: string,
  mtimeMs: number
): Promise<SessionSummary | null> {
  const sessionId = path.basename(file, ".jsonl");
  let head: string;
  try {
    const fh = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }

  let cwd: string | undefined;
  let firstPrompt = "";
  for (const line of head.split("\n")) {
    const o = parseLine(line);
    if (!o) continue;
    if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
    if (
      !firstPrompt &&
      o.type === "user" &&
      !isHiddenUserLine(o) &&
      !isInjectedUserLine(o)
    ) {
      firstPrompt = firstUserText(o.message).trim();
    }
    if (cwd && firstPrompt) break;
  }
  if (!cwd && !firstPrompt) return null;

  // The CLI writes its generated conversation title as `ai-title` lines — one
  // per turn, all carrying the same current title, so the LAST one wins. That
  // is where the SDK's `summary`/`customTitle` came from; without it the list
  // falls back to the first prompt.
  const aiTitle = await lastAiTitle(file);

  return {
    sessionId,
    provider: "claude",
    summary: aiTitle || summarize(firstPrompt) || "Claude conversation",
    lastModified: mtimeMs,
    cwd,
    firstPrompt: firstPrompt || undefined,
    customTitle: aiTitle || undefined,
  };
}

// ai-title lines are appended as the conversation goes, so the newest one is
// near the end — read a bounded tail rather than the whole transcript.
const TAIL_BYTES = 256 * 1024;

async function lastAiTitle(file: string): Promise<string> {
  let tail: string;
  try {
    const fh = await fs.open(file, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const len = size - start;
      if (len <= 0) return "";
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      tail = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
  let title = "";
  for (const line of tail.split("\n")) {
    const o = parseLine(line);
    if (o && o.type === "ai-title" && typeof o.aiTitle === "string") {
      title = o.aiTitle;
    }
  }
  return title.trim();
}

export async function listClaudeSessions(opts: {
  limit: number;
  dir?: string;
}): Promise<SessionSummary[]> {
  const root = projectsDir();
  // With a cwd filter, go straight to that project's directory — that is how
  // Claude Code files them, so a scan would only add cost.
  const dirs = opts.dir
    ? [path.join(root, projectSlug(opts.dir))]
    : await (async () => {
        try {
          const names = await fs.readdir(root);
          return names.map((n) => path.join(root, n));
        } catch {
          return [];
        }
      })();

  const files: Array<{ file: string; mtimeMs: number }> = [];
  for (const d of dirs) {
    for (const file of await listJsonl(d)) {
      try {
        const st = await fs.stat(file);
        if (st.isFile() && st.size > 0) {
          files.push({ file, mtimeMs: st.mtimeMs });
        }
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  // Newest first, then read only as many heads as the caller asked for.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: SessionSummary[] = [];
  for (const { file, mtimeMs } of files) {
    if (out.length >= opts.limit) break;
    const s = await summaryFor(file, mtimeMs);
    if (s) out.push(s);
  }
  return out;
}

export async function getClaudeSessionMessages(
  id: string,
  opts: { dir?: string; limit?: number } = {}
): Promise<ClaudeSessionMessage[]> {
  const file = await findSessionFile(id, opts.dir);
  if (!file) return [];
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const msgs: ClaudeSessionMessage[] = [];
  for (const line of raw.split("\n")) {
    const o = parseLine(line);
    if (!o) continue;
    const m = toMessage(o);
    if (m) msgs.push(m);
  }
  // A limit keeps the most RECENT messages: the UI opens scrolled to the end.
  const limit = opts.limit;
  return limit && msgs.length > limit ? msgs.slice(msgs.length - limit) : msgs;
}

export async function deleteClaudeSession(
  id: string,
  opts: { dir?: string } = {}
): Promise<boolean> {
  const file = await findSessionFile(id, opts.dir);
  if (!file) return false;
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}
