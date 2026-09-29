// Reader for Claude Code's native session files, replacing the
// `listSessions` / `getSessionMessages` / `deleteSession` helpers that came
// from @anthropic-ai/claude-agent-sdk. The CLI has no equivalent commands, so
// dropping the SDK means owning this. Mirrors the Codex-side reader in
// server/session-store.ts.
//
// Layout: ~/.claude/projects/<slug>/<sessionId>.jsonl, append-only, one JSON
// object per line. cc-webui only ever reads (and deletes whole sessions).

import { unwrapMemoryPrompt, stripMemoryMessage } from "../shared/project-memory-envelope.ts";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import type { SessionSummary } from "./session-store.ts";
import { splitAttachments } from "../src/lib/attachments.ts";

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
  /**
   * 这一行里那个 content block 在 API 消息里的**真实下标**。
   *
   * ⚠️ CLI 把一条 API 消息拆成**一行一个 block** 写进 jsonl（实测 2.1.267：
   * `[thinking]` / `[text]` / `[tool_use]` 三行共用同一个 `message.id`，每行
   * content 长度都是 1），所以行内下标恒为 0 —— 真实下标只剩这个字段记着。
   * 前端拿它拼事件 id，好和流式那一侧的 `stream_event.event.index` 对齐；
   * 丢了它，同一段话会被渲染两遍（见 src/lib/processor.ts 的注释）。
   */
  api_block_index?: number;
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
  apiBlockIndex?: unknown;
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
    message: stripMemoryMessage(o.message),
    timestamp: typeof o.timestamp === "string" ? o.timestamp : undefined,
    api_block_index:
      typeof o.apiBlockIndex === "number" ? o.apiBlockIndex : undefined,
  };
}

// 没有 ai-title 时，标题退回第一条消息。那条消息如果带着附件，开头是一整段
// 「附件：- /var/folders/…/cc-webui-uploads/…」（Composer 写给 agent 看的），直接压成
// 标题就是一行临时目录路径（用户 2026-09-23 截图里侧栏那条）。所以先剥掉附件那段：
// 有正文用正文，只发了附件就用文件名。
export function summarize(prompt: string): string {
  const { files, body } = splitAttachments(unwrapMemoryPrompt(prompt));
  const text = files.length
    ? body.trim() || files.map((f) => f.name).join("、")
    : prompt;
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? compact.slice(0, 79) + "..." : compact;
}

function firstUserText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (stripMemoryMessage(message) as { content?: unknown }).content;
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

// 头部要找的两样东西：`cwd` 和第一条**真**用户消息（meta / 注入的不算）。
type Head = { cwd?: string; firstPrompt: string };

// 吃一行，返回「两样都齐了」。两条读法共用它。
function takeHead(head: Head, line: string): boolean {
  const o = parseLine(line);
  if (o) {
    if (!head.cwd && typeof o.cwd === "string") head.cwd = o.cwd;
    if (
      !head.firstPrompt &&
      o.type === "user" &&
      !isHiddenUserLine(o) &&
      !isInjectedUserLine(o)
    ) {
      head.firstPrompt = firstUserText(o.message).trim();
    }
  }
  return !!head.cwd && !!head.firstPrompt;
}

// 快路径：一次 pread 读头 256KB。实测本机 979 个 jsonl 里 975 个在这一窗里就齐了，
// 所以这条路径决定了列表和顶栏搜索的耗时（978 条全拿 ≈ 840ms）。
const HEAD_BYTES = 256 * 1024;

async function readHeadWindow(file: string): Promise<Head> {
  const head: Head = { firstPrompt: "" };
  const fh = await fs.open(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    text = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
  for (const line of text.split("\n")) {
    if (takeHead(head, line)) break;
  }
  return head;
}

// 慢路径，只在上面那一窗**什么都没捞到**时走（979 里 4 个）。
//
// ⚠️⚠️ 为什么需要它（2026-09-07 用户报的「怎么看不到 rebecca 的会话了」）：CLI 把
// `queue-operation` 写在文件最前面——那是排队中的消息，带图片附件时**一条就上百
// KB**，两条就填满 256KB 的窗口。于是窗口里一个 cwd、一个 user 行都不剩 →
// `summaryFor` 返回 null → **这条会话在侧栏和顶栏搜索里彻底消失**，而文件好好地
// 躺在盘上（本机中招 3 条，最大那条 7.2MB 正是用户天天在用的）。
// 所以兜底的这条按**行**扫、拿到就停，不再有「固定窗口」这个前提。
//
// 行数/字节数只是上界，防的是「一个几十 MB、从头到尾没有任何消息行的文件被整读」。
const MAX_HEAD_LINES = 500;
const MAX_HEAD_BYTES = 8 * 1024 * 1024;

async function scanHead(file: string): Promise<Head> {
  const head: Head = { firstPrompt: "" };
  const stream = createReadStream(file, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lines = 0;
  let bytes = 0;
  try {
    for await (const line of rl) {
      lines++;
      bytes += line.length + 1;
      if (takeHead(head, line)) break;
      // 上界的检查放在处理**之后**：哪怕第一行自己就超了预算，它也已经被看过
      // 一眼——带 cwd 的往往正是那一行。
      if (lines >= MAX_HEAD_LINES || bytes >= MAX_HEAD_BYTES) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return head;
}

async function summaryFor(
  file: string,
  mtimeMs: number
): Promise<SessionSummary | null> {
  const sessionId = path.basename(file, ".jsonl");
  let head: Head;
  try {
    head = await readHeadWindow(file);
    if (!head.cwd && !head.firstPrompt) head = await scanHead(file);
  } catch {
    // readdir 与读之间文件消失了。
    return null;
  }
  const { cwd, firstPrompt } = head;
  // 两样都没有 = 文件里除了 bookkeeping 什么都没有（起了个会话、一个 turn 都没
  // 跑完）。没有可显示的东西，不进列表。
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

// 这个会话在**任何**项目目录里都还有文件吗。POST /chat 续聊前用它判断
// 「要续的会话是不是已经被删掉了」（见 chat.ts）。
export async function claudeSessionExists(id: string, dir?: string): Promise<boolean> {
  return (await findSessionFile(id, dir)) !== null;
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
