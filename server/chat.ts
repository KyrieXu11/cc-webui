import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { query } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { awaitPermission } from "./permission.ts";

const chat = new Hono();

function expandHome(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

const ALLOWED_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
const ALLOWED_EFFORTS: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

chat.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prompt: string = body.prompt ?? "";
  const sessionId: string | undefined = body.sessionId;
  const cwd = expandHome(body.cwd || process.env.CC_WEBUI_CWD);
  const model: string | undefined = body.model;
  const permissionMode: PermissionMode | undefined = ALLOWED_MODES.includes(
    body.permissionMode
  )
    ? body.permissionMode
    : undefined;
  const effort: EffortLevel | undefined = ALLOWED_EFFORTS.includes(body.effort)
    ? body.effort
    : undefined;

  type IncomingImage = { name?: string; mediaType?: string; data?: string };
  const rawImages: IncomingImage[] = Array.isArray(body.images)
    ? body.images
    : [];
  const images = rawImages.filter(
    (img): img is { name?: string; mediaType: string; data: string } =>
      typeof img?.mediaType === "string" &&
      img.mediaType.startsWith("image/") &&
      typeof img.data === "string" &&
      img.data.length > 0
  );

  if (!prompt.trim() && images.length === 0) {
    return c.json({ error: "prompt or images required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    let aborted = false;
    const ac = new AbortController();
    stream.onAbort(() => {
      aborted = true;
      ac.abort();
    });

    try {
      const queryPrompt =
        images.length > 0
          ? (async function* () {
              const content: any[] = [];
              if (prompt.trim()) content.push({ type: "text", text: prompt });
              for (const img of images) {
                content.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: img.mediaType,
                    data: img.data,
                  },
                });
              }
              yield {
                type: "user" as const,
                message: { role: "user" as const, content },
                parent_tool_use_id: null,
              };
            })()
          : prompt;

      const response = query({
        prompt: queryPrompt as any,
        options: {
          resume: sessionId,
          cwd,
          model,
          permissionMode,
          effort,
          includePartialMessages: true,
          canUseTool: async (toolName, input, opts) => {
            const id = randomUUID();
            await stream.writeSSE({
              event: "permission_request",
              data: JSON.stringify({
                type: "permission_request",
                id,
                tool: toolName,
                input,
              }),
            });
            const decision = await awaitPermission(id, opts.signal);
            return decision;
          },
        },
      });

      for await (const msg of response) {
        if (aborted) break;
        await stream.writeSSE({
          event: msg.type,
          data: JSON.stringify(msg),
        });
      }

      await stream.writeSSE({ event: "done", data: "" });
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  });
});

export { chat };
