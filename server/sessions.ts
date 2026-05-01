import { Hono } from "hono";
import {
  listSessions as listClaudeSessions,
  getSessionMessages as getClaudeSessionMessages,
  deleteSession as deleteClaudeSession,
} from "@anthropic-ai/claude-agent-sdk";
import {
  deleteCodexSession,
  getCodexSessionTurns,
  listCodexSessions,
  type AgentProvider,
  type SessionSummary,
} from "./session-store.ts";

const sessionsRoute = new Hono();

type ProviderFilter = AgentProvider | "all";

function providerFilter(raw: string | undefined): ProviderFilter {
  return raw === "claude" || raw === "codex" || raw === "all" ? raw : "all";
}

async function listClaude(opts: {
  limit: number;
  dir?: string;
}): Promise<SessionSummary[]> {
  const sessions = await listClaudeSessions({
    limit: opts.limit,
    dir: opts.dir,
  });
  return sessions.map((s) => ({ ...s, provider: "claude" as const }));
}

sessionsRoute.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 30);
  const dir = c.req.query("cwd") || undefined;
  const provider = providerFilter(c.req.query("provider"));
  try {
    const groups = await Promise.all([
      provider === "codex" ? [] : listClaude({ limit, dir }),
      provider === "claude" ? [] : listCodexSessions({ limit, cwd: dir }),
    ]);
    const sessions = groups
      .flat()
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, limit);
    return c.json({ sessions });
  } catch (e) {
    return c.json({ sessions: [], error: String(e) });
  }
});

sessionsRoute.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const dir = c.req.query("cwd") || undefined;
  const limit = Number(c.req.query("limit") ?? 5000);
  const provider = providerFilter(c.req.query("provider"));
  try {
    if (provider === "codex") {
      const messages = await getCodexSessionTurns(id);
      return c.json({ provider: "codex", messages });
    }
    const messages = await getClaudeSessionMessages(id, { dir, limit });
    return c.json({ provider: "claude", messages });
  } catch (e) {
    return c.json({ messages: [], error: String(e) });
  }
});

sessionsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const dir = c.req.query("cwd") || undefined;
  const provider = providerFilter(c.req.query("provider"));
  try {
    if (provider === "codex") {
      await deleteCodexSession(id);
    } else {
      await deleteClaudeSession(id, { dir });
    }
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

export { sessionsRoute };
