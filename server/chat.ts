import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { query } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { awaitPermission } from "./permission.ts";
import { createBashMcpServer, relabelTasksSessionId } from "./bash-mcp.ts";

const MCP_BASH_RUN = "mcp__bash__run";
const MCP_BASH_OUTPUT = "mcp__bash__output";
const MCP_BASH_KILL = "mcp__bash__kill";
const SYSTEM_PROMPT_BASH_APPEND =
  "SHELL TOOLS: The built-in Bash/BashOutput/KillBash tools are DISABLED. " +
  `Use ${MCP_BASH_RUN} (same schema: command, timeout, description, plus run_in_background). ` +
  `For background tasks, poll with ${MCP_BASH_OUTPUT} (bash_id) and terminate with ${MCP_BASH_KILL} (bash_id). ` +
  "Do not try to invoke the built-in Bash — it will be rejected.";

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

// Session-scoped tool allowances: when the user picks "allow_session" on a
// permission prompt, the tool name is remembered here and future calls for the
// same sessionId auto-approve without re-prompting. Keyed by the SDK session_id,
// which can be emitted mid-stream on the very first turn; we migrate the set to
// the real id when that happens.
const sessionAllowances = new Map<string, Set<string>>();

function getOrCreateAllowance(id: string | undefined): Set<string> {
  if (!id) return new Set<string>();
  let set = sessionAllowances.get(id);
  if (!set) {
    set = new Set<string>();
    sessionAllowances.set(id, set);
  }
  return set;
}

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

  const reqId = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  console.log(
    `[chat ${reqId}] start resume=${sessionId ?? "-"} cwd=${cwd ?? "-"}` +
      ` model=${model ?? "default"} mode=${permissionMode ?? "default"}` +
      ` images=${images.length} prompt=${JSON.stringify(prompt.slice(0, 80))}`
  );

  return streamSSE(c, async (stream) => {
    let aborted = false;
    const ac = new AbortController();
    stream.onAbort(() => {
      aborted = true;
      ac.abort();
      console.log(`[chat ${reqId}] SSE aborted at ${elapsed()}`);
    });

    let currentSessionId = sessionId;
    const allowance = getOrCreateAllowance(currentSessionId);

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

      const bashMcp = createBashMcpServer({
        cwd,
        getSessionId: () => currentSessionId,
      });

      const response = query({
        prompt: queryPrompt as any,
        options: {
          resume: sessionId,
          cwd,
          model,
          permissionMode,
          effort,
          includePartialMessages: true,
          mcpServers: { bash: bashMcp },
          disallowedTools: ["Bash", "BashOutput", "KillBash"],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: SYSTEM_PROMPT_BASH_APPEND,
          },
          canUseTool: async (toolName, input, opts) => {
            if (
              toolName === MCP_BASH_OUTPUT ||
              toolName === MCP_BASH_KILL
            ) {
              return { behavior: "allow", updatedInput: input };
            }
            if (allowance.has(toolName)) {
              return { behavior: "allow", updatedInput: input };
            }
            const id = randomUUID();
            const displayTool =
              toolName === MCP_BASH_RUN ? "Bash" : toolName;
            await stream.writeSSE({
              event: "permission_request",
              data: JSON.stringify({
                type: "permission_request",
                id,
                tool: displayTool,
                input,
              }),
            });
            const decision = await awaitPermission(id, opts.signal);
            if (decision.behavior === "allow") {
              return { behavior: "allow", updatedInput: input };
            }
            if (decision.behavior === "allow_session") {
              allowance.add(toolName);
              return { behavior: "allow", updatedInput: input };
            }
            return decision;
          },
        },
      });

      let msgCount = 0;
      for await (const msg of response) {
        if (aborted) break;
        msgCount++;
        const tag =
          (msg as any).type +
          ((msg as any).subtype ? `:${(msg as any).subtype}` : "");
        if (msgCount <= 20 || msgCount % 50 === 0) {
          console.log(`[chat ${reqId}] msg #${msgCount} ${tag} @${elapsed()}`);
        }
        const emittedId = (msg as any).session_id as string | undefined;
        if (emittedId && emittedId !== currentSessionId) {
          const previousId = currentSessionId;
          if (!previousId) {
            sessionAllowances.set(emittedId, allowance);
          } else if (sessionAllowances.get(previousId) === allowance) {
            sessionAllowances.delete(previousId);
            sessionAllowances.set(emittedId, allowance);
          }
          relabelTasksSessionId(previousId, emittedId);
          currentSessionId = emittedId;
        }
        await stream.writeSSE({
          event: msg.type,
          data: JSON.stringify(msg),
        });
      }

      console.log(
        `[chat ${reqId}] done aborted=${aborted} msgs=${msgCount} in ${elapsed()}`
      );
      await stream.writeSSE({ event: "done", data: "" });
    } catch (err) {
      console.error(`[chat ${reqId}] ERROR at ${elapsed()}:`, err);
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
