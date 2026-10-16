import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendCodexTurn } from "./session-store.ts";
import { prepareProjectMemory } from "./project-memory/runtime.ts";
import { codexAppServerExecutor } from "./executors/codex-app-server.ts";
import { WEB_OUTPUT_RULES } from "./web-output-rules.ts";
import { CODEX_ARTIFACT_PLUGIN_PROMPT } from "./codex-plugin-policy.ts";
import type { ExecResult, SteerSend } from "./executors/types.ts";
import { memorySnapshot } from "./project-memory/prompt.ts";
import type { MemoryCapability } from "./project-memory/runtime.ts";
import { wrapMemoryPrompt } from "../shared/project-memory-envelope.ts";
import { assertCanOpen } from "./auth/paths.ts";
import { getAllowedPaths } from "./auth/users.ts";
import { SteeringRequests, SteerConflict, pickSteerTurn, validSteerInput } from "./steering.ts";
import { getMcpRouteUrl } from "./codex-mcp-config.ts";
import {
  registerMcpSessionContext,
  unregisterMcpSessionContext,
  updateMcpSession,
} from "./mcp-context.ts";
import {
  relabelTasksSessionId,
  resolveTaskSessionId,
  subscribeForegroundEvents,
} from "./bash-mcp.ts";
import { isCodexNonFatalNotice } from "./codex-events.ts";
import { assertProviderAllowed } from "./auth/users.ts";
import { currentUser, isAdmin } from "./auth/middleware.ts";
import { visibilityFor } from "./auth/scope.ts";
import { recordOwner, relabelOwner } from "./auth/ownership.ts";

const codexChat = new Hono();
const KEEPALIVE_MS = 15_000;
const CODEX_RUNTIME_PROMPT =
  "WEBUI RUNTIME: For shell commands, prefer the MCP bash tools. " +
  "Use mcp__bash__run with run_in_background=true for long-running commands; " +
  "poll with mcp__bash__output, terminate with mcp__bash__kill, and discover existing tasks with mcp__bash__list. " +
  "Foreground mcp__bash__run commands can be detached by the UI." + CODEX_ARTIFACT_PLUGIN_PROMPT + WEB_OUTPUT_RULES;

type BufferedMsg = { event: string; data: string };

interface Subscriber {
  write: (event: string, data: string) => void;
  close: () => void;
}

interface InFlightCodexChat {
  reqId: string;
  clientTurnId: string | undefined;
  threadId: string | undefined;
  messages: BufferedMsg[];
  subscribers: Set<Subscriber>;
  status: "running" | "done" | "error";
  errorMsg?: string;
  cancelRequested: boolean;
  abort: AbortController;
  ownerId?: string;
  cwd: string;
  permissionMode?: string;
  projectMemory?: MemoryCapability;
  steer?: SteerSend | null;
  steering: SteeringRequests;
}

const activeCodexChats = new Map<string, InFlightCodexChat>();
const activeCodexChatsByClientTurn = new Map<string, InFlightCodexChat>();

function expandHome(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function streamSSEUnbuffered(
  c: Parameters<typeof streamSSE>[0],
  cb: (stream: SSEStreamingApi) => Promise<void>
): Response {
  const res = streamSSE(c, cb);
  res.headers.set("Cache-Control", "no-cache, no-transform");
  res.headers.set("X-Accel-Buffering", "no");
  return res;
}

function removeEntryIfSelf(entry: InFlightCodexChat): void {
  if (entry.threadId && activeCodexChats.get(entry.threadId) === entry) {
    activeCodexChats.delete(entry.threadId);
  }
  if (
    entry.clientTurnId &&
    activeCodexChatsByClientTurn.get(entry.clientTurnId) === entry
  ) {
    activeCodexChatsByClientTurn.delete(entry.clientTurnId);
  }
}

async function attachStreamToEntry(
  stream: SSEStreamingApi,
  entry: InFlightCodexChat,
  callerId: string | undefined
): Promise<void> {
  const subId = Math.random().toString(36).slice(2, 7);
  const tag = `[codex sub ${entry.reqId}/${subId}]`;
  let writeCount = 0;
  const queue: BufferedMsg[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const doWake = () => {
    if (!wake) return;
    const r = wake;
    wake = null;
    r();
  };

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
    for (const m of snapshot) {
      if (closed) break;
      try {
        await stream.writeSSE(m);
        writeCount++;
      } catch (e) {
        console.log(
          `${tag} replay write threw after ${writeCount}:`,
          (e as any)?.message
        );
        closed = true;
        break;
      }
    }
    // Personalized capability is not buffered/fanned out to shared readers.
    if (!closed) await stream.writeSSE({ event: "steer_target", data: JSON.stringify({
      type: "steer_target", provider: "codex", clientTurnId: entry.clientTurnId,
      canSteer: !!callerId && callerId === entry.ownerId && entry.status === "running",
    }) });
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
        console.log(
          `${tag} live write threw after ${writeCount}:`,
          (e as any)?.message
        );
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

// The cc-webui runtime preamble Codex needs (it has no --append-system-prompt
// equivalent, so it rides in the prompt itself). Images travel as ExecOptions
// attachments now — the executor spills them to disk and cleans up, so the
// temp-dir bookkeeping that used to live here is gone.
function composePrompt(prompt: string): string {
  return prompt.trim()
    ? `${CODEX_RUNTIME_PROMPT}\n\nUSER REQUEST:\n${prompt}`
    : CODEX_RUNTIME_PROMPT;
}

type IncomingImage = { name?: string; mediaType?: string; data?: string };

function validImages(images: IncomingImage[]) {
  return images.filter(
    (img): img is { name?: string; mediaType: string; data: string } =>
      typeof img?.mediaType === "string" &&
      img.mediaType.startsWith("image/") &&
      typeof img.data === "string" &&
      img.data.length > 0
  );
}

function fanoutFactory(entry: InFlightCodexChat) {
  return (event: string, data: string) => {
    const item: BufferedMsg = { event, data };
    entry.messages.push(item);
    for (const sub of entry.subscribers) sub.write(event, data);
  };
}

codexChat.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prompt: string = body.prompt ?? "";
  const startedAt = Date.now();
  const threadId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const clientTurnId: string =
    typeof body.clientTurnId === "string" && body.clientTurnId
      ? body.clientTurnId
      : randomUUID();
  const cwd = expandHome(body.cwd || process.env.CC_WEBUI_CWD);
  const model: string | undefined =
    typeof body.model === "string" ? body.model : undefined;
  const effort: string | undefined =
    typeof body.effort === "string" ? body.effort : undefined;
  const permissionMode: string | undefined =
    typeof body.permissionMode === "string" ? body.permissionMode : undefined;
  if (permissionMode === "bypassPermissions" && !isAdmin(c)) {
    return c.json({ error: "bypassPermissions is admin-only" }, 403);
  }
  const rawImages: IncomingImage[] = Array.isArray(body.images)
    ? body.images
    : [];

  if (!prompt.trim() && rawImages.length === 0) {
    return c.json({ error: "prompt or images required" }, 400);
  }
  if (threadId && activeCodexChats.has(threadId)) {
    const prior = activeCodexChats.get(threadId)!;
    return c.json(
      {
        error: "session_busy",
        message: `Codex thread ${threadId} is still processing prior message (reqId ${prior.reqId})`,
      },
      409
    );
  }
  if (clientTurnId && activeCodexChatsByClientTurn.has(clientTurnId)) {
    const prior = activeCodexChatsByClientTurn.get(clientTurnId)!;
    return c.json(
      {
        error: "turn_busy",
        message: `Codex turn ${clientTurnId} is still processing (reqId ${prior.reqId})`,
      },
      409
    );
  }

  const reqId = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  console.log(
    `[codex ${reqId}] start resume=${threadId ?? "-"} cwd=${cwd ?? "-"}` +
      ` model=${model ?? "default"} mode=${permissionMode ?? "default"}` +
      ` prompt=${JSON.stringify(prompt.slice(0, 80))}`
  );

  const ownerId = currentUser(c)?.id;
  const turnEvents: unknown[] = [];
  const acceptedSteers = new Set<string>();
  const entry: InFlightCodexChat = {
    reqId,
    clientTurnId,
    threadId,
    messages: [],
    subscribers: new Set(),
    status: "running",
    cancelRequested: false,
    abort: new AbortController(),
    ownerId, cwd: cwd ?? process.cwd(), permissionMode,
    steering: new SteeringRequests(),
  };
  if (threadId) activeCodexChats.set(threadId, entry);
  if (clientTurnId) activeCodexChatsByClientTurn.set(clientTurnId, entry);

  const fanout = fanoutFactory(entry);
  fanout("turn_meta", JSON.stringify({ type: "turn_meta", effort: effort ?? null, startedAt, provider: "codex" }));
  // Publish our raw request once; app-server's native user items are ignored.
  // A viewer attaching from another
  // tab/account has no browser-local ActiveTurn, and the current turn isn't in
  // our persisted history yet. Replay the raw request BEFORE any CLI output.
  fanout("turn_user", JSON.stringify({
    type: "turn_user", provider: "codex", startedAt, clientTurnId, prompt,
    images: validImages(rawImages),
  }));

  (async () => {
    let unsubscribeForeground: (() => void) | undefined;
    const mcpToken = randomUUID();
    let taskSessionId = threadId ?? clientTurnId ?? `codex-turn-${reqId}`;
    try {
      assertProviderAllowed(ownerId, "codex", permissionMode);
      const memory = await prepareProjectMemory(ownerId, cwd ?? process.cwd(), "codex", permissionMode);
      entry.projectMemory = memory?.capability;
      registerMcpSessionContext({
        token: mcpToken,
        sessionId: taskSessionId,
        ownerId,
        cwd,
        projectMemory: memory?.capability,
        onMemoryUpdated: () => fanout("memory_updated", JSON.stringify({ type: "memory_updated" })),
      });
      unsubscribeForeground = subscribeForegroundEvents((event, data) => {
        try {
          const payload = JSON.parse(data) as { sessionId?: string };
          // Compare canonical (alias-resolved) ids on both sides so events
          // emitted under a placeholder id (before thread.started) still
          // match after the session is relabeled to its real thread_id.
          const a = resolveTaskSessionId(payload.sessionId);
          const b = resolveTaskSessionId(taskSessionId);
          if (a !== b) return;
          fanout(event, data);
        } catch {
          /* ignore malformed foreground event */
        }
      });

      // Web-only app-server: groups/Feishu keep their existing exec driver.
      const frames = codexAppServerExecutor.exec({
        onSteerAccepted: id => {
          const text = entry.steering.text(id);
          if (text === undefined || acceptedSteers.has(id)) return;
          acceptedSteers.add(id);
          return { type: "steer_user", id: `u-steer-${id}`, provider: "codex", text };
        },
        onSteer: send => {
          entry.steer = send;
          fanout("steer_available", JSON.stringify({ type: "steer_available", available: !!send, provider: "codex", clientTurnId }));
        },
        prompt: memory ? memory.wrap(prompt, CODEX_RUNTIME_PROMPT + memory.rules) : composePrompt(prompt),
        disableNativeMemory: !!memory,
        images: validImages(rawImages),
        cwd: cwd ?? process.cwd(),
        signal: entry.abort.signal,
        model,
        effort,
        mode: permissionMode,
        ...(threadId ? { resume: threadId } : {}),
        // ⚠️ bash only — deliberately NOT the `schedule` server Claude gets,
        // and deliberately NOT the desktop-client `local-*` ones
        // (docs/desktop-client.md 决策 19: only server/chat.ts assembles those).
        mcpServers: [
          ...(memory ? [{ name: "memory", url: getMcpRouteUrl(process.env, "memory"), bearerToken: mcpToken }] : []),
          {
            name: "bash",
            url: getMcpRouteUrl(process.env, "bash"),
            bearerToken: mcpToken,
          },
        ],
      });

      let eventCount = 0;
      let ended: ExecResult | null = null;
      for await (const frame of frames) {
        if (frame.kind === "ended") {
          ended = frame.result;
          break;
        }
        // The executor owns interruption and drains frames already received;
        // an acknowledged steer must not vanish when cancellation races it.
        // app-server notifications are normalized to the legacy UI frame
        // shape by the executor; the SSE/persistence path stays shared.
        const ev = frame.payload as any;
        if (ev.type === "codex_retry") console.log(`[codex ${reqId}] model_retry ${ev.status} @${elapsed()}`);
        // Drop only known non-fatal CLI notices; retain genuine errors and
        // unknown config/security warnings (also filtered during UI replay).
        if (isCodexNonFatalNotice(ev)) continue;
        eventCount++;
        if (eventCount <= 20 || eventCount % 50 === 0) {
          console.log(`[codex ${reqId}] event #${eventCount} ${ev.type} @${elapsed()}`);
        }
        if (ev.type === "thread.started") {
          const previousTaskSessionId = taskSessionId;
          taskSessionId = ev.thread_id;
          updateMcpSession(mcpToken, ev.thread_id);
          if (previousTaskSessionId !== ev.thread_id) {
            relabelTasksSessionId(previousTaskSessionId, ev.thread_id);
          }
          entry.threadId = ev.thread_id;
          activeCodexChats.set(ev.thread_id, entry);
          // Codex issues the thread id, so ownership is recorded here — see the
          // same pattern in chat.ts.
          if (ownerId) {
            recordOwner(ev.thread_id, "codex", ownerId);
            relabelOwner(previousTaskSessionId, ev.thread_id);
          }
        }
        turnEvents.push(ev);
        fanout("codex_event", JSON.stringify(ev));
      }

      console.log(
        `[codex ${reqId}] ${entry.cancelRequested ? "cancelled" : (ended?.status ?? "done")}` +
          ` events=${eventCount} in ${elapsed()}` +
          (ended?.error ? ` error=${JSON.stringify(ended.error)}` : "")
      );
      // A cancelled turn is not an error (the executor reports `aborted`, which
      // it can only know because it did the killing — the exit code alone says
      // "failed"). Everything else that isn't `completed` is surfaced to the
      // user, since the SDK used to throw on exactly those.
      if (ended && ended.status !== "completed" && ended.status !== "aborted") {
        throw new Error(ended.error ?? `run ${ended.status}`);
      }
      entry.status = "done";
    } catch (err) {
      if (entry.cancelRequested) {
        entry.status = "done";
      } else {
        const message = err instanceof Error ? err.message : String(err);
        turnEvents.push({ type: "error", message });
        console.error(`[codex ${reqId}] ERROR at ${elapsed()}:`, err);
        entry.status = "error";
        entry.errorMsg = message;
      }
    } finally {
      entry.steer = null;
      // A turn/steer ACK can race with turn/completed. Let accepted input
      // publish before persistence and the terminal SSE frame.
      await entry.steering.settled();
      // Persist BEFORE emitting the terminal event so any client that refetches
      // the session list on `done` (e.g. ProjectSidebar's refreshKey) sees the
      // newly-saved session. Also keeps `error` ordering consistent.
      if (entry.threadId && turnEvents.length > 0) {
        await appendCodexTurn({
          sessionId: entry.threadId,
          cwd,
          prompt,
          startedAt,
          images: validImages(rawImages),
          events: turnEvents,
        }).catch((err) => {
          console.error(`[codex ${reqId}] failed to persist session:`, err);
        });
      }
      if (entry.status === "error") {
        fanout(
          "error",
          JSON.stringify({ message: entry.errorMsg ?? "unknown error" })
        );
      } else {
        fanout("done", "");
      }
      unsubscribeForeground?.();
      unregisterMcpSessionContext(mcpToken);
      for (const sub of [...entry.subscribers]) sub.close();
      removeEntryIfSelf(entry);
    }
  })().catch((err) =>
    console.error(`[codex ${reqId}] unhandled in detached task:`, err)
  );

  return streamSSEUnbuffered(c, async (stream) => {
    await attachStreamToEntry(stream, entry, currentUser(c)?.id);
  });
});

codexChat.post("/chat/steer", async c => {
  const body = await c.req.json().catch(() => ({}));
  if (!validSteerInput(body)) return c.json({ error: "invalid steer input" }, 400);
  const entry = pickSteerTurn(body, id => activeCodexChats.get(id), id => activeCodexChatsByClientTurn.get(id));
  const unavailable = (reason: string, retryable = false) => c.json({ error: "steer_unavailable", reason, retryable,
    message: retryable ? "当前轮正在准备接收追加" : "当前轮不再接受追加，会按顺序发出" }, 409);
  if (!entry || entry.status !== "running" || entry.cancelRequested) return unavailable("turn_ended");
  if (entry.ownerId !== currentUser(c)?.id) return unavailable("different_actor");
  try {
    assertProviderAllowed(entry.ownerId, "codex", entry.permissionMode);
    await assertCanOpen(entry.cwd, getAllowedPaths(entry.ownerId!));
  } catch { return c.json({ error: "当前账号的 AI 或项目访问权限已改变" }, 403); }
  if (!entry.steer) return unavailable("not_ready", true);
  try {
    const ok = await entry.steering.run(body.messageId, body.text, async () => {
      let text = body.text;
      if (entry.projectMemory) text = wrapMemoryPrompt(await memorySnapshot(entry.projectMemory.scope), text);
      if (!entry.steer || entry.cancelRequested) return false;
      if (!await entry.steer(text, body.messageId)) return false;
      return true;
    });
    return ok ? c.json({ ok: true }) : unavailable("turn_ended");
  } catch (error) {
    if (error instanceof SteerConflict) return c.json({ error: error.message }, 400);
    // Unknown outcome is not a 409: never send the same text again as a new
    // turn when the native ACK may have been lost after acceptance.
    return c.json({ error: "追加消息未能确认送达，请检查当前对话后重试" }, 503);
  }
});

codexChat.post("/chat/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const threadId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" ? body.clientTurnId : undefined;
  const entry =
    (clientTurnId ? activeCodexChatsByClientTurn.get(clientTurnId) : undefined) ??
    (threadId ? activeCodexChats.get(threadId) : undefined);
  if (!entry) return c.json({ ok: false, reason: "not_found" }, 404);
  if (entry.status !== "running") {
    return c.json({ ok: false, reason: `already_${entry.status}` });
  }
  entry.cancelRequested = true;
  entry.abort.abort();
  return c.json({ ok: true });
});

codexChat.get("/chat/inflight", (c) => {
  // Scoped: previously every caller saw every running thread id.
  const visible = visibilityFor(currentUser(c)!);
  const sessionIds = Array.from(activeCodexChats.keys()).filter(visible);
  return c.json({ sessionIds });
});

codexChat.get("/chat/attach", (c) => {
  const threadId = c.req.query("sessionId");
  const clientTurnId = c.req.query("clientTurnId");
  return streamSSEUnbuffered(c, async (stream) => {
    if (!threadId && !clientTurnId) {
      await stream.writeSSE({ event: "no-inflight", data: "" });
      return;
    }
    const entry =
      (threadId ? activeCodexChats.get(threadId) : undefined) ??
      (clientTurnId ? activeCodexChatsByClientTurn.get(clientTurnId) : undefined);
    if (!entry) {
      await stream.writeSSE({ event: "no-inflight", data: "" });
      return;
    }
    await attachStreamToEntry(stream, entry, currentUser(c)?.id);
  });
});

export { codexChat };
