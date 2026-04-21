import { Hono } from "hono";
import {
  listSessions,
  getSessionMessages,
  deleteSession,
} from "@anthropic-ai/claude-agent-sdk";

const sessionsRoute = new Hono();

sessionsRoute.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 30);
  const dir = c.req.query("cwd") || undefined;
  try {
    const sessions = await listSessions({ limit, dir });
    return c.json({ sessions });
  } catch (e) {
    return c.json({ sessions: [], error: String(e) });
  }
});

sessionsRoute.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const dir = c.req.query("cwd") || undefined;
  const limit = Number(c.req.query("limit") ?? 5000);
  try {
    const messages = await getSessionMessages(id, { dir, limit });
    return c.json({ messages });
  } catch (e) {
    return c.json({ messages: [], error: String(e) });
  }
});

sessionsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const dir = c.req.query("cwd") || undefined;
  try {
    await deleteSession(id, { dir });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

export { sessionsRoute };
