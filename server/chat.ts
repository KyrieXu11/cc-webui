import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { query } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import path from "node:path";

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

  if (!prompt.trim()) {
    return c.json({ error: "prompt required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    try {
      const response = query({
        prompt,
        options: {
          resume: sessionId,
          cwd,
          model,
          permissionMode,
          effort,
          includePartialMessages: true,
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
