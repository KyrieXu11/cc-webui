import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { awaitPermission } from "./permission.ts";
import { createBashMcpServer, relabelTasksSessionId } from "./bash-mcp.ts";
import { createScheduleMcpServer } from "./schedule-mcp.ts";
import {
  createWakeupSlot,
  type WakeupRequest,
  type WakeupSlot,
} from "./wakeup.ts";

const MCP_BASH_RUN = "mcp__bash__run";
const MCP_BASH_OUTPUT = "mcp__bash__output";
const MCP_BASH_KILL = "mcp__bash__kill";
const MCP_SCHEDULE_WAKEUP = "mcp__schedule__wakeup";
const MCP_SCHEDULE_CANCEL_WAKEUP = "mcp__schedule__cancel_wakeup";
const SYSTEM_PROMPT_APPEND =
  "SHELL TOOLS: The built-in Bash/BashOutput/KillBash tools are DISABLED. " +
  `Use ${MCP_BASH_RUN} (same schema: command, timeout, description, plus run_in_background). ` +
  `For background tasks, poll with ${MCP_BASH_OUTPUT} (bash_id) and terminate with ${MCP_BASH_KILL} (bash_id). ` +
  "Do not try to invoke the built-in Bash — it will be rejected.\n" +
  "WAKEUP / SELF-RESUMING: The built-in ScheduleWakeup tool is NOT available in this runtime. " +
  `Use ${MCP_SCHEDULE_WAKEUP} (delaySeconds 60..3600, prompt, optional reason) before ending your turn ` +
  "if you want the conversation to auto-resume — typically after starting a long-running " +
  `${MCP_BASH_RUN} (run_in_background=true) task. The injected prompt must be self-contained ` +
  `(no human in the loop). Cancel with ${MCP_SCHEDULE_CANCEL_WAKEUP} if you change your mind.`;

const chat = new Hono();
const KEEPALIVE_MS = 15_000;

function streamSSEUnbuffered(
  c: Context,
  cb: (stream: SSEStreamingApi) => Promise<void>
): Response {
  const res = streamSSE(c, cb);
  res.headers.set("Cache-Control", "no-cache, no-transform");
  res.headers.set("X-Accel-Buffering", "no");
  return res;
}

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

// Explicit WebUI-only allowances. These are separate from Claude Code's own
// session permission suggestions.
const sessionToolAllowances = new Map<string, Set<string>>();
const sessionInputAllowances = new Map<string, Set<string>>();

function getOrCreateAllowance(id: string | undefined): Set<string> {
  if (!id) return new Set<string>();
  let set = sessionToolAllowances.get(id);
  if (!set) {
    set = new Set<string>();
    sessionToolAllowances.set(id, set);
  }
  return set;
}

function getOrCreateInputAllowance(id: string | undefined): Set<string> {
  if (!id) return new Set<string>();
  let set = sessionInputAllowances.get(id);
  if (!set) {
    set = new Set<string>();
    sessionInputAllowances.set(id, set);
  }
  return set;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function permissionInputKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${stableStringify(input)}`;
}

function sessionPermissionSuggestions(
  suggestions: readonly PermissionUpdate[] | undefined
): PermissionUpdate[] {
  return (suggestions ?? []).filter((s) => {
    if (s.destination !== "session") return false;
    if (s.type === "addRules") {
      return s.behavior === "allow" && s.rules.length > 0;
    }
    if (s.type === "addDirectories") {
      return s.directories.length > 0;
    }
    return false;
  });
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
  cancelRequested: boolean;
  source: "user" | "wakeup";
  // Calls response.return() on the SDK iterator to force the for-await in
  // the detached task to exit early. Set after `query()` returns.
  cancelIterator?: () => Promise<void>;
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

// ============================================================
// Wakeup scheduling (Claude-Code-ScheduleWakeup-style auto-resume)
// ============================================================
//
// When the model calls `mcp__schedule__wakeup` mid-turn, the schedule MCP
// stashes the request into the current turn's WakeupSlot. After the SDK
// iterator finishes (entry.status === "done"), we read the slot and arm a
// setTimeout that, when it fires, kicks off a fresh turn via runChatTurn()
// using `resume: sessionId` and the model-supplied prompt. UI / pulse
// handling falls out automatically because the new entry registers itself
// in activeChats just like any user-driven turn.

interface PendingWakeup {
  sessionId: string;
  request: WakeupRequest;
  timeout: NodeJS.Timeout;
  // Inherited from the parent turn so the wakeup-driven turn runs against
  // the same cwd / model / permissionMode / effort.
  parentOpts: TurnOptions;
}

const wakeupTimers = new Map<string, PendingWakeup>();

function cancelPendingWakeup(sid: string | undefined): WakeupRequest | null {
  if (!sid) return null;
  const t = wakeupTimers.get(sid);
  if (!t) return null;
  clearTimeout(t.timeout);
  wakeupTimers.delete(sid);
  console.log(
    `[wakeup ${t.request.id}] cancelled for session ${sid} (${t.request.delaySeconds}s pending)`
  );
  return t.request;
}

function scheduleWakeup(
  sid: string,
  request: WakeupRequest,
  parentOpts: TurnOptions
): void {
  cancelPendingWakeup(sid);
  const timeout = setTimeout(() => {
    wakeupTimers.delete(sid);
    if (activeChats.has(sid)) {
      console.log(
        `[wakeup ${request.id}] session ${sid} already busy, skipping`
      );
      return;
    }
    console.log(
      `[wakeup ${request.id}] firing for session ${sid} after ${request.delaySeconds}s`
    );
    try {
      runChatTurn({
        ...parentOpts,
        sessionId: sid,
        clientTurnId: undefined,
        prompt: request.prompt,
        images: [],
        source: "wakeup",
        wakeupReason: request.reason,
      });
    } catch (err) {
      console.error(`[wakeup ${request.id}] failed to start turn:`, err);
    }
  }, request.delaySeconds * 1000);
  wakeupTimers.set(sid, { sessionId: sid, request, timeout, parentOpts });
  console.log(
    `[wakeup ${request.id}] scheduled for session ${sid} in ${request.delaySeconds}s`
  );
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
  const keepAlive = setInterval(() => {
    sub.write("ping", "");
  }, KEEPALIVE_MS);
  console.log(
    `${tag} attached, snapshot=${snapshot.length}, status=${entry.status}`
  );
  stream.onAbort(() => {
    closed = true;
    doWake();
    console.log(`${tag} onAbort, wrote=${writeCount}`);
  });

  try {
    try {
      await stream.writeSSE({ event: "ping", data: "" });
      writeCount++;
    } catch (e) {
      console.log(`${tag} initial ping threw:`, (e as any)?.message);
      closed = true;
    }
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
    clearInterval(keepAlive);
    entry.subscribers.delete(sub);
    console.log(`${tag} detached, total wrote=${writeCount}`);
  }
}

// ============================================================
// runChatTurn — start a turn, return its InFlightChat entry
// ============================================================
//
// Used by both POST /chat (user-initiated) and the wakeup scheduler
// (auto-resume after a setTimeout fires). The detached SDK loop runs
// independently of any HTTP request.

interface NormalizedImage {
  name?: string;
  mediaType: string;
  data: string;
}

interface TurnOptions {
  sessionId: string | undefined;
  clientTurnId: string | undefined;
  prompt: string;
  images: NormalizedImage[];
  cwd: string | undefined;
  model: string | undefined;
  permissionMode: PermissionMode | undefined;
  effort: EffortLevel | undefined;
  source: "user" | "wakeup";
  wakeupReason?: string | null;
}

function runChatTurn(opts: TurnOptions): InFlightChat {
  const reqId = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  console.log(
    `[chat ${reqId}] start source=${opts.source} resume=${opts.sessionId ?? "-"} cwd=${opts.cwd ?? "-"}` +
      ` model=${opts.model ?? "default"} mode=${opts.permissionMode ?? "default"}` +
      ` images=${opts.images.length} prompt=${JSON.stringify(opts.prompt.slice(0, 80))}`
  );

  const entry: InFlightChat = {
    reqId,
    clientTurnId: opts.clientTurnId,
    messages: [],
    subscribers: new Set(),
    status: "running",
    sessionId: opts.sessionId,
    cancelRequested: false,
    source: opts.source,
  };
  if (opts.sessionId) activeChats.set(opts.sessionId, entry);
  if (opts.clientTurnId) activeChatsByClientTurn.set(opts.clientTurnId, entry);

  let currentSessionId = opts.sessionId;
  const allowance = getOrCreateAllowance(currentSessionId);
  const inputAllowance = getOrCreateInputAllowance(currentSessionId);
  const wakeupSlot: WakeupSlot = createWakeupSlot();

  // Broadcast: append to buffer + push to every subscriber synchronously.
  const fanout = (event: string, data: string) => {
    const item: BufferedMsg = { event, data };
    entry.messages.push(item);
    for (const sub of entry.subscribers) sub.write(event, data);
  };

  if (opts.source === "wakeup") {
    fanout(
      "wakeup_turn_started",
      JSON.stringify({
        type: "wakeup_turn_started",
        reqId,
        prompt: opts.prompt,
        reason: opts.wakeupReason ?? null,
        sessionId: opts.sessionId,
      })
    );
  }

  // Detached SDK run — lives past the HTTP request's lifetime.
  (async () => {
    try {
      const queryPrompt =
        opts.images.length > 0
          ? (async function* () {
              const content: any[] = [];
              if (opts.prompt.trim()) content.push({ type: "text", text: opts.prompt });
              for (const img of opts.images) {
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
          : opts.prompt;

      const bashMcp = createBashMcpServer({
        cwd: opts.cwd,
        getSessionId: () => currentSessionId,
        // Pipe foreground lifecycle events into the chat SSE fanout so
        // connected clients can track which fgId is currently pending (Ctrl+B
        // detaches the most recent).
        onForegroundEvent: fanout,
      });

      const scheduleMcp = createScheduleMcpServer({ slot: wakeupSlot });

      const response = query({
        prompt: queryPrompt as any,
        options: {
          resume: opts.sessionId,
          cwd: opts.cwd,
          model: opts.model,
          permissionMode: opts.permissionMode,
          effort: opts.effort,
          includePartialMessages: true,
          mcpServers: { bash: bashMcp, schedule: scheduleMcp },
          disallowedTools: ["Bash", "BashOutput", "KillBash"],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: SYSTEM_PROMPT_APPEND,
          },
          canUseTool: async (toolName, input, permOpts) => {
            if (
              toolName === MCP_BASH_OUTPUT ||
              toolName === MCP_BASH_KILL ||
              toolName === MCP_SCHEDULE_WAKEUP ||
              toolName === MCP_SCHEDULE_CANCEL_WAKEUP
            ) {
              return { behavior: "allow", updatedInput: input };
            }
            if (allowance.has(toolName)) {
              return { behavior: "allow", updatedInput: input };
            }
            const inputKey = permissionInputKey(toolName, input);
            if (inputAllowance.has(inputKey)) {
              return { behavior: "allow", updatedInput: input };
            }
            const permissionSuggestions = sessionPermissionSuggestions(
              permOpts.suggestions
            );
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
                title: permOpts.title,
                displayName: permOpts.displayName,
                description: permOpts.description,
                hasSessionPermissionSuggestions:
                  permissionSuggestions.length > 0,
                // Carry the SDK's toolUseID so the client can match the card
                // to the corresponding step (`s-<toolUseID>`) and know when
                // the step is actually executing vs waiting on approval.
                toolUseId: permOpts.toolUseID,
              })
            );
            const decision = await awaitPermission(id, permOpts.signal);
            if (decision.behavior === "allow") {
              return { behavior: "allow", updatedInput: input };
            }
            if (decision.behavior === "allow_session") {
              inputAllowance.add(inputKey);
              if (permissionSuggestions.length === 0) {
                return { behavior: "allow", updatedInput: input };
              }
              return {
                behavior: "allow",
                updatedInput: input,
                updatedPermissions: permissionSuggestions,
              };
            }
            if (decision.behavior === "allow_tool_session") {
              allowance.add(toolName);
              return { behavior: "allow", updatedInput: input };
            }
            return decision;
          },
        },
      });

      // Give the cancel route a way to terminate the iterator early. SDK's
      // query() doesn't accept an external AbortSignal, so calling .return()
      // on the async iterator is the only handle.
      entry.cancelIterator = async () => {
        try {
          await (response as any).return?.();
        } catch {
          /* iterator may throw on return — ignore */
        }
      };

      let msgCount = 0;
      let currentStreamMessageId: string | undefined;
      for await (const msg of response) {
        if (entry.cancelRequested) break;
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
        // Re-key tool allowances, task sessionIds, and activeChats together.
        const emittedId = m.session_id as string | undefined;
        if (emittedId && emittedId !== currentSessionId) {
          const previousId = currentSessionId;
          if (!previousId) {
            sessionToolAllowances.set(emittedId, allowance);
            sessionInputAllowances.set(emittedId, inputAllowance);
          } else if (sessionToolAllowances.get(previousId) === allowance) {
            sessionToolAllowances.delete(previousId);
            sessionToolAllowances.set(emittedId, allowance);
          }
          if (
            previousId &&
            sessionInputAllowances.get(previousId) === inputAllowance
          ) {
            sessionInputAllowances.delete(previousId);
            sessionInputAllowances.set(emittedId, inputAllowance);
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
        `[chat ${reqId}] ${entry.cancelRequested ? "cancelled" : "done"} msgs=${msgCount} in ${elapsed()}`
      );
      entry.status = "done";

      // Surface pending wakeup BEFORE the terminal `done` event so the UI can
      // pin a countdown badge as soon as the turn ends. We still defer the
      // actual setTimeout-arm until after the entry is cleaned up so that
      // activeChats.has(sid) is a meaningful "is this session still busy"
      // check when the timer fires.
      const pendingWakeup =
        !entry.cancelRequested && entry.sessionId
          ? wakeupSlot.get()
          : null;
      if (pendingWakeup) {
        fanout(
          "wakeup_pending",
          JSON.stringify({
            type: "wakeup_pending",
            id: pendingWakeup.id,
            sessionId: entry.sessionId,
            delaySeconds: pendingWakeup.delaySeconds,
            scheduledAt: pendingWakeup.scheduledAt,
            firesAt: pendingWakeup.scheduledAt + pendingWakeup.delaySeconds * 1000,
            reason: pendingWakeup.reason,
            prompt: pendingWakeup.prompt,
          })
        );
      }

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

      // Arm the wakeup AFTER cleanup so activeChats no longer holds this
      // entry — a "session busy" check inside the timer reflects user-driven
      // turns, not the just-finished one.
      if (entry.status === "done" && !entry.cancelRequested && entry.sessionId) {
        const pending = wakeupSlot.get();
        if (pending) {
          scheduleWakeup(entry.sessionId, pending, opts);
        }
      }
    }
  })().catch((err) =>
    console.error(`[chat ${reqId}] unhandled in detached task:`, err)
  );

  return entry;
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
  const images: NormalizedImage[] = rawImages
    .filter(
      (img): img is { name?: string; mediaType: string; data: string } =>
        typeof img?.mediaType === "string" &&
        img.mediaType.startsWith("image/") &&
        typeof img.data === "string" &&
        img.data.length > 0
    )
    .map((img) => ({
      name: img.name,
      mediaType: img.mediaType,
      data: img.data,
    }));

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

  // User submitted a fresh message — drop any wakeup that was waiting to
  // auto-resume this session, since the human is back in the loop.
  cancelPendingWakeup(sessionId);

  const entry = runChatTurn({
    sessionId,
    clientTurnId,
    prompt,
    images,
    cwd,
    model,
    permissionMode,
    effort,
    source: "user",
  });

  return streamSSEUnbuffered(c, async (stream) => {
    await attachStreamToEntry(stream, entry);
  });
});

// ============================================================
// POST /chat/cancel — stop an in-flight turn
// ============================================================

chat.post("/chat/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" ? body.clientTurnId : undefined;

  // Cancel a pending wakeup even if the session has no active in-flight
  // turn — the user explicitly asked to stop, so don't auto-resume later.
  const cancelledWakeup = cancelPendingWakeup(sessionId);

  const entry =
    (clientTurnId ? activeChatsByClientTurn.get(clientTurnId) : undefined) ??
    (sessionId ? activeChats.get(sessionId) : undefined);
  if (!entry) {
    if (cancelledWakeup) {
      return c.json({ ok: true, cancelledWakeup: cancelledWakeup.id });
    }
    return c.json({ ok: false, reason: "not_found" }, 404);
  }
  if (entry.status !== "running") {
    return c.json({ ok: false, reason: `already_${entry.status}` });
  }

  entry.cancelRequested = true;
  console.log(`[chat ${entry.reqId}] cancel requested`);
  // Fire-and-forget — the iterator's return() unblocks the detached for-await,
  // which then goes through its finally and closes subscribers cleanly.
  entry.cancelIterator?.().catch(() => {});
  return c.json({
    ok: true,
    ...(cancelledWakeup ? { cancelledWakeup: cancelledWakeup.id } : {}),
  });
});

// ============================================================
// GET /chat/inflight — list sessions with an active turn
// ============================================================
//
// Used by the sidebar to draw a pulsing dot on sessions that are currently
// generating. Lightweight: clients poll this every few seconds rather than
// subscribing via SSE.

chat.get("/chat/inflight", (c) => {
  const sessionIds = Array.from(activeChats.keys());
  return c.json({ sessionIds });
});

// ============================================================
// GET /chat/wakeups — list sessions with a pending wakeup
// ============================================================
//
// Returns one entry per session that has a wakeup armed. UI can use this to
// show a countdown badge and offer a manual-cancel button.

chat.get("/chat/wakeups", (c) => {
  const wakeups = Array.from(wakeupTimers.values()).map((w) => ({
    sessionId: w.sessionId,
    id: w.request.id,
    delaySeconds: w.request.delaySeconds,
    scheduledAt: w.request.scheduledAt,
    firesAt: w.request.scheduledAt + w.request.delaySeconds * 1000,
    reason: w.request.reason,
    prompt: w.request.prompt,
  }));
  return c.json({ wakeups });
});

// ============================================================
// POST /chat/wakeups/cancel — cancel a pending wakeup
// ============================================================

chat.post("/chat/wakeups/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  if (!sessionId) {
    return c.json({ ok: false, reason: "sessionId required" }, 400);
  }
  const cancelled = cancelPendingWakeup(sessionId);
  return c.json(
    cancelled
      ? { ok: true, id: cancelled.id }
      : { ok: false, reason: "not_found" }
  );
});

// ============================================================
// GET /chat/attach — reconnect to an in-flight turn
// ============================================================

chat.get("/chat/attach", (c) => {
  const sessionId = c.req.query("sessionId");
  const clientTurnId = c.req.query("clientTurnId");
  return streamSSEUnbuffered(c, async (stream) => {
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
