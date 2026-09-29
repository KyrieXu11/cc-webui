import { Hono } from "hono";
import { currentUser } from "./auth/middleware.ts";
import { MemoryError, resolveMemoryScope } from "./project-memory/scope.ts";
import { listMemory, readMemory } from "./project-memory/store.ts";
import { importClaudeMemory } from "./project-memory/import.ts";
import { projectMemoryEnabled } from "./features.ts";
const route = new Hono();
route.onError((e, c) => e instanceof MemoryError ? c.json({
  error: e.code,
  detail: e.message
}, e.code === "not_found" ? 404 : e.code === "scope_unavailable" ? 403 : 400) : c.json({
  error: "storage_unavailable",
  detail: "项目记忆暂不可用"
}, 503));
route.get("/", async c => {
  const scope = await resolveMemoryScope(currentUser(c)!.id, c.req.query("cwd")!);
  const page = await listMemory(scope, Number(c.req.query("cursor") ?? 0), 100);
  const records = await Promise.all(page.entries.map(async entry => {
    try {
      return await readMemory(scope, entry.id);
    } catch (e) {
      if (e instanceof MemoryError && e.code === "not_found") return null;
      throw e;
    }
  }));
  const memories = records.filter(r => r !== null).map(r => ({
    id: r.id,
    file: r.name + ".md",
    name: r.name,
    description: r.description,
    type: r.type,
    modified: new Date(r.updatedAt).toISOString(),
    body: r.body,
    truncated: false,
    revision: r.revision,
    provider: r.provider
  }));
  return c.json({
    dir: "cc-webui · 当前项目共用",
    index: memories.map(m => `- [${m.name}](${m.file}) — ${m.description}`).join("\n"),
    memories,
    enabled: projectMemoryEnabled(),
    total: page.total,
    nextCursor: page.next_cursor
  });
});
route.post("/import", async c => {
  const body = await c.req.json();
  const scope = await resolveMemoryScope(currentUser(c)!.id, body.cwd);
  if (!Array.isArray(body.files)) return c.json({
    error: "files required"
  }, 400);
  return c.json({
    results: await importClaudeMemory(scope, body.files, body.cwd)
  });
});
export { route as projectMemoryRoute };
