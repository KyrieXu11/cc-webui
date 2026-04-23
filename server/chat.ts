import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
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
// same sessionId auto-approve without re-prompting.
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

// ============================================================
// In-flight chat registry
// ============================================================
//
// Each active SDK turn is represented by an InFlightChat. The turn runs as a
// detached async task — independent of the HTTP request that started it — so
// that a browser refresh / tab close / session switch doesn't cancel the
// generation. All SDK-produced messages are buffered in `messages` and fanned
// out to every Subscriber. A late-joining client (via GET /chat/attach)
// replays the buffer and then follows live until the turn ends.

type BufferedMsg = { event: string; data: string };

interface Subscriber {
  write: (event: string, data: string) => void;
  close: () => void;
}

interface InFlightChat {
  reqId: string;
  clientTurnId: string | undefined;
  messages: BufferedMsg[];
  subscribers: Set<Subscriber>;
  status: "running" | "done" | "error";
  errorMsg?: string;
  sessionId: string | undefined;
}

const activeChats = new Map<string, InFlightChat>();
const activeChatsByClientTurn = new Map<string, InFlightChat>();

function removeEntryIfSelf(entry: InFlightChat): void {
  if (entry.sessionId && activeChats.get(entry.sessionId) === entry) {
    activeChats.delete(entry.sessionId);
  }
  if (
    entry.clientTurnId &&
    activeChatsByClientTurn.get(entry.clientTurnId) === entry
  ) {
    activeChatsByClientTurn.delete(entry.clientTurnId);
  }
}

// Attach a stream to an entry as a subscriber. Replays the current buffer
// snapshot, then drains live messages until the entry terminates or the
// stream disconnects. Returns a promise that resolves when the subscriber
// has fully drained.
async function attachStreamToEntry(
  stream: SSEStreamingApi,
  entry: InFlightChat
): Promise<void> {
  const subId = Math.random().toString(36).slice(2, 7);
  const tag = `[sub ${entry.reqId}/${subId}]`;
  let writeCount = 0;
  const queue: BufferedMsg[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const doWake = () => {
    if (wake) {
      const r = wake;
      wake = null;
      r();
    }
  };

  // Take a snapshot of already-buffered messages for replay. Subscriber is
  // registered in the same synchronous block — since JS can't interleave, no
  // fanout can happen between the two, so no dedup / skip logic is needed:
  // every message is either in `snapshot` (replayed) or arrives via
  // sub.write afterwards (queued). Never both, never lost.
  const snapshot = entry.messages.slice();

  const sub: Subscriber = {
    write: (event, data) => {
      if (closed) return;
      queue.push({ event, data });
      doWake();
    },
    close: () => {
      closed = true;
      doWake();
    },
  };
  entry.subscribers.add(sub);
  console.log(
    `${tag} attached, snapshot=${snapshot.length}, status=${entry.status}`
  );
  stream.onAbort(() => {
    closed = true;
    doWake();
    console.log(`${tag} onAbort, wrote=${writeCount}`);
  });

  try {
    // Replay existing buffer (includes done/error if entry has terminated).
    for (const m of snapshot) {
      if (closed) break;
      try {
        await stream.writeSSE(m);
        writeCount++;
      } catch (e) {
        console.log(`${tag} replay write threw after ${writeCount}:`, (e as any)?.message);
        closed = true;
        break;
      }
    }
    // Drain live queue until closed. Keep draining even after close as long
    // as there are queued items (done/error usually arrives right before
    // close and we want the client to see it).
    while (!closed || queue.length > 0) {
      if (queue.length === 0) {
        if (closed) break;
        await new Promise<void>((r) => {
          wake = r;
        });
        continue;
      }
      const item = queue.shift()!;
      try {
        await stream.writeSSE(item);
        writeCount++;
      } catch (e) {
        console.log(`${tag} live write threw after ${writeCount}:`, (e as any)?.message);
        closed = true;
        break;
      }
    }
  } finally {
    entry.subscribers.delete(sub);
    console.log(`${tag} detached, total wrote=${writeCount}`);
  }
}

// ============================================================
// POST /chat — start a new turn
// ============================================================

chat.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prompt: string = body.prompt ?? "";
  const sessionId: string | undefined = body.sessionId;
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" && body.clientTurnId
      ? body.clientTurnId
      : undefined;
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

  // Reject if same session already has an in-flight turn. Caller should wait
  // for the prior turn to finish (or switch to attach endpoint to observe it).
  if (sessionId && activeChats.has(sessionId)) {
    const prior = activeChats.get(sessionId)!;
    return c.json(
      {
        error: "session_busy",
        message: `Session ${sessionId} is still processing prior message (reqId ${prior.reqId})`,
      },
      409
    );
  }
  if (clientTurnId && activeChatsByClientTurn.has(clientTurnId)) {
    const prior = activeChatsByClientTurn.get(clientTurnId)!;
    return c.json(
      {
        error: "turn_busy",
        message: `Turn ${clientTurnId} is still processing (reqId ${prior.reqId})`,
      },
      409
    );
  }

  const reqId = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  console.log(
    `[chat ${reqId}] start resume=${sessionId ?? "-"} cwd=${cwd ?? "-"}` +
      ` model=${model ?? "default"} mode=${permissionMode ?? "default"}` +
      ` images=${images.length} prompt=${JSON.stringify(prompt.slice(0, 80))}`
  );

  const entry: InFlightChat = {
    reqId,
    clientTurnId,
    messages: [],
    subscribers: new Set(),
    status: "running",
    sessionId,
  };
  if (sessionId) activeChats.set(sessionId, entry);
  if (clientTurnId) activeChatsByClientTurn.set(clientTurnId, entry);

  let currentSessionId = sessionId;
  const allowance = getOrCreateAllowance(currentSessionId);

  // Broadcast: append to buffer + push to every subscriber synchronously.
  const fanout = (event: string, data: string) => {
    const item: BufferedMsg = { event, data };
    entry.messages.push(item);
    for (const sub of entry.subscribers) sub.write(event, data);
  };

  // Detached SDK run — lives past the HTTP request's lifetime.
  (async () => {
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
            // Fan out the permission prompt so any subscriber (initiator or
            // reconnect attach) can surface the card and answer it.
            fanout(
              "permission_request",
              JSON.stringify({
                type: "permission_request",
                id,
                tool: displayTool,
                input,
              })
            );
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
      let currentStreamMessageId: string | undefined;
      for await (const msg of response) {
        msgCount++;
        const tag =
          (msg as any).type +
          ((msg as any).subtype ? `:${(msg as any).subtype}` : "");
        if (msgCount <= 20 || msgCount % 50 === 0) {
          console.log(`[chat ${reqId}] msg #${msgCount} ${tag} @${elapsed()}`);
        }
        // Diagnostic: dump status messages and any tool_use content blocks so
        // we can see why the model isn't actually invoking mcp__bash__run.
        const m = msg as any;
        if (m.type === "system" && m.subtype === "status") {
          console.log(
            `[chat ${reqId}] status payload: ${JSON.stringify(m).slice(0, 500)}`
          );
        }
        if (
          m.type === "stream_event" &&
          m.event?.type === "content_block_start"
        ) {
          const cb = m.event.content_block;
          if (cb?.type === "tool_use") {
            console.log(
              `[chat ${reqId}] tool_use: ${cb.name} input=${JSON.stringify(cb.input ?? {}).slice(0, 200)}`
            );
          }
        }

        let outboundMsg = msg as any;
        if (outboundMsg.type === "stream_event" && outboundMsg.event) {
          const ev = outboundMsg.event;
          if (ev.type === "message_start") {
            currentStreamMessageId =
              ev.message?.id ?? outboundMsg.uuid ?? currentStreamMessageId;
          }
          if (currentStreamMessageId) {
            outboundMsg = {
              ...outboundMsg,
              stream_message_id: currentStreamMessageId,
            };
          }
        }

        // Migrate session identity the moment SDK emits a real session_id.
        // Re-key sessionAllowances, task sessionIds, and activeChats together.
        const emittedId = m.session_id as string | undefined;
        if (emittedId && emittedId !== currentSessionId) {
          const previousId = currentSessionId;
          if (!previousId) {
            sessionAllowances.set(emittedId, allowance);
          } else if (sessionAllowances.get(previousId) === allowance) {
            sessionAllowances.delete(previousId);
            sessionAllowances.set(emittedId, allowance);
          }
          relabelTasksSessionId(previousId, emittedId);
          if (previousId && activeChats.get(previousId) === entry) {
            activeChats.delete(previousId);
          }
          activeChats.set(emittedId, entry);
          entry.sessionId = emittedId;
          currentSessionId = emittedId;
        }

        fanout(outboundMsg.type, JSON.stringify(outboundMsg));
        if (
          outboundMsg.type === "stream_event" &&
          outboundMsg.event?.type === "message_stop"
        ) {
          currentStreamMessageId = undefined;
        }
      }

      console.log(
        `[chat ${reqId}] done msgs=${msgCount} in ${elapsed()}`
      );
      entry.status = "done";
      fanout("done", "");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[chat ${reqId}] ERROR at ${elapsed()}:`, err);
      entry.status = "error";
      entry.errorMsg = message;
      fanout("error", JSON.stringify({ message }));
    } finally {
      // Close subscribers so their drain loops wake up and exit. The terminal
      // event ("done" / "error") has already been fanned out into their
      // queues; the drain loop is keyed off `!closed || queue.length > 0`.
      for (const sub of [...entry.subscribers]) sub.close();
      removeEntryIfSelf(entry);
    }
  })().catch((err) =>
    console.error(`[chat ${reqId}] unhandled in detached task:`, err)
  );

  return streamSSE(c, async (stream) => {
    await attachStreamToEntry(stream, entry);
  });
});

// ============================================================
// GET /chat/attach — reconnect to an in-flight turn
// ============================================================

chat.get("/chat/attach", (c) => {
  const sessionId = c.req.query("sessionId");
  const clientTurnId = c.req.query("clientTurnId");
  return streamSSE(c, async (stream) => {
    if (!sessionId && !clientTurnId) {
      await stream.writeSSE({ event: "no-inflight", data: "" });
      return;
    }
    const entry =
      (sessionId ? activeChats.get(sessionId) : undefined) ??
      (clientTurnId ? activeChatsByClientTurn.get(clientTurnId) : undefined);
    if (!entry) {
      await stream.writeSSE({ event: "no-inflight", data: "" });
      return;
    }
    await attachStreamToEntry(stream, entry);
  });
});

export { chat };
