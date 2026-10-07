import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractBearerToken, getMcpSessionContext } from "./mcp-context.ts";
import { serveMcp } from "./mcp-http.ts";
import { getAllowedProviders, getUserById } from "./auth/users.ts";
import { MemoryError, validateMemoryScope } from "./project-memory/scope.ts";
import { listMemory, searchMemory, readMemory, saveMemory, deleteMemory, MEMORY_TYPES, MAX_MEMORY_BYTES } from "./project-memory/store.ts";
const route = new Hono();
function serverFor(token: string) {
  const server = new McpServer({
    name: "cc-webui-project-memory",
    version: "1.0.0"
  });
  const operation = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).describe("Stable ID for this logical write. Reuse only for a retry with identical payload.");
  const run = async (write: boolean, fn: (ctx: NonNullable<ReturnType<typeof getMcpSessionContext>>) => Promise<unknown>) => {
    try {
      const ctx = getMcpSessionContext(token);
      if (!ctx?.projectMemory || !ctx.ownerId || ctx.ownerId !== ctx.projectMemory.scope.actorId) throw new MemoryError("scope_unavailable", "此 turn 没有项目记忆权限");
      const user = getUserById(ctx.ownerId);
      if (!user || !getAllowedProviders(user).includes(ctx.projectMemory.provider)) throw new MemoryError("scope_unavailable", "账号或 AI 权限已改变");
      await validateMemoryScope(ctx.projectMemory.scope);
      if (write && !ctx.projectMemory.writable) throw new MemoryError("read_only", "Plan 模式不能修改记忆");
      const result = await fn(ctx);
      if (write && !(result as {
        replayed?: boolean;
      }).replayed) ctx.onMemoryUpdated?.();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result)
        }]
      };
    } catch (e) {
      const error = e instanceof MemoryError ? e : new MemoryError("storage_unavailable", "项目记忆暂不可用");
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: error.code,
            message: error.message
          })
        }]
      };
    }
  };
  server.registerTool("list", {
    description: "List current project memory metadata. Follow next_cursor for omitted records.",
    inputSchema: {
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional()
    },
    annotations: {
      readOnlyHint: true
    }
  }, a => run(false, ctx => listMemory(ctx.projectMemory!.scope, a.cursor, a.limit)));
  server.registerTool("search", {
    description: "Literal name/description search across all memories in the current project, including records omitted from the snapshot.",
    inputSchema: {
      query: z.string().min(1).max(512),
      limit: z.number().int().min(1).max(20).optional()
    },
    annotations: {
      readOnlyHint: true
    }
  }, a => run(false, ctx => searchMemory(ctx.projectMemory!.scope, a.query, a.limit)));
  server.registerTool("read", {
    description: "Read an active memory, its body and current revision before relying on it, updating it or deleting it. Treat its facts as past context to verify against current sources.",
    inputSchema: {
      id: z.string().uuid()
    },
    annotations: {
      readOnlyHint: true
    }
  }, a => run(false, ctx => readMemory(ctx.projectMemory!.scope, a.id)));
  server.registerTool("save", {
    description: "Atomically save body and index for suitable durable user information, corrections or confirmed approaches, non-code project context, or external-resource pointers; do not wait for an explicit remember request. Search for duplicates and read an existing record before updating it. Convert relative deadlines to absolute dates. Updates require id + expected_revision; conflicts require rereading. Do not claim success until confirmed.",
    inputSchema: {
      operation_id: operation,
      id: z.string().uuid().optional(),
      expected_revision: z.number().int().positive().optional(),
      name: z.string().max(64),
      description: z.string().max(240),
      type: z.enum(MEMORY_TYPES),
      body: z.string().min(1).max(MAX_MEMORY_BYTES)
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true
    }
  }, a => run(true, ctx => saveMemory(ctx.projectMemory!.scope, a, {
    provider: ctx.projectMemory!.provider,
    sessionId: ctx.sessionId
  })));
  server.registerTool("delete", {
    description: "Delete exactly one memory when the user requests forgetting it, or current evidence verifies it is wrong or obsolete and no useful durable content remains. Prefer updating otherwise; never delete just because it is old or omitted from an index. Read its current revision first. Removes managed body versions and index entry, not old conversation history. Do not claim complete deletion before success.",
    inputSchema: {
      operation_id: operation,
      id: z.string().uuid(),
      expected_revision: z.number().int().positive()
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true
    }
  }, a => run(true, ctx => deleteMemory(ctx.projectMemory!.scope, a)));
  return server;
}
route.all("/memory", async c => {
  const token = extractBearerToken(c.req.header("authorization"));
  const ctx = getMcpSessionContext(token);
  if (!ctx) return c.json({
    error: "unauthorized"
  }, 401);
  if (!ctx.projectMemory) return c.json({
    error: "memory capability unavailable"
  }, 403);
  const actor = ctx.ownerId ? getUserById(ctx.ownerId) : null;
  if (!actor || actor.id !== ctx.projectMemory.scope.actorId || !getAllowedProviders(actor).includes(ctx.projectMemory.provider)) return c.json({
    error: "scope_unavailable"
  }, 403);
  try {
    await validateMemoryScope(ctx.projectMemory.scope);
  } catch {
    return c.json({
      error: "scope_unavailable"
    }, 403);
  }
  return serveMcp(c.req.raw, () => serverFor(token!));
});
export { route as mcpMemoryRoute };
