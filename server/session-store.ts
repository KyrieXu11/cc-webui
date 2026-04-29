import fs from "node:fs/promises";
import os from "node:os";
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

interface CodexStoredSession extends SessionSummary {
  provider: "codex";
  turns: CodexStoredTurn[];
}

interface StoreFile {
  codexSessions: CodexStoredSession[];
}

const STORE_PATH =
  process.env.CC_WEBUI_SESSION_INDEX ||
  path.join(os.homedir(), ".cc-webui", "sessions.json");

function summarizePrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? compact.slice(0, 79) + "..." : compact;
}

async function readStore(): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    return {
      codexSessions: Array.isArray(parsed.codexSessions)
        ? parsed.codexSessions
        : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { codexSessions: [] };
    }
    throw err;
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, STORE_PATH);
}

export async function listCodexSessions(opts: {
  limit: number;
  cwd?: string;
}): Promise<SessionSummary[]> {
  const store = await readStore();
  return store.codexSessions
    .filter((s) => !opts.cwd || s.cwd === opts.cwd)
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, opts.limit)
    .map(({ turns: _turns, ...summary }) => summary);
}

export async function getCodexSessionTurns(
  sessionId: string
): Promise<CodexStoredTurn[]> {
  const store = await readStore();
  return store.codexSessions.find((s) => s.sessionId === sessionId)?.turns ?? [];
}

export async function appendCodexTurn(opts: {
  sessionId: string;
  cwd?: string;
  prompt: string;
  startedAt: number;
  events: unknown[];
}): Promise<void> {
  const store = await readStore();
  const now = Date.now();
  let session = store.codexSessions.find((s) => s.sessionId === opts.sessionId);
  if (!session) {
    const summary = summarizePrompt(opts.prompt) || "Codex conversation";
    session = {
      sessionId: opts.sessionId,
      provider: "codex",
      cwd: opts.cwd,
      summary,
      firstPrompt: opts.prompt,
      lastModified: now,
      turns: [],
    };
    store.codexSessions.push(session);
  }

  session.cwd = opts.cwd ?? session.cwd;
  session.firstPrompt = session.firstPrompt || opts.prompt;
  session.summary = session.summary || summarizePrompt(opts.prompt);
  session.lastModified = now;
  session.turns.push({
    provider: "codex",
    prompt: opts.prompt,
    startedAt: opts.startedAt,
    events: opts.events,
  });

  await writeStore(store);
}

export async function deleteCodexSession(sessionId: string): Promise<boolean> {
  const store = await readStore();
  const before = store.codexSessions.length;
  store.codexSessions = store.codexSessions.filter(
    (s) => s.sessionId !== sessionId
  );
  if (store.codexSessions.length === before) return false;
  await writeStore(store);
  return true;
}
