import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import {
  Codex,
  type ApprovalMode,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type UserInput,
} from "@openai/codex-sdk";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { appendCodexTurn } from "./session-store.ts";

const codexChat = new Hono();
const KEEPALIVE_MS = 15_000;
const MAX_CODEX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

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
  entry: InFlightCodexChat
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

function mapPermissionMode(mode: string | undefined): {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
} {
  if (mode === "bypassPermissions") {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
  if (mode === "plan") {
    return { sandboxMode: "read-only", approvalPolicy: "never" };
  }
  return { sandboxMode: "workspace-write", approvalPolicy: "never" };
}

function mapEffort(effort: string | undefined): ModelReasoningEffort {
  if (effort === "low" || effort === "medium" || effort === "high") {
    return effort;
  }
  if (effort === "xhigh" || effort === "max") return "xhigh";
  return "medium";
}

type IncomingImage = { name?: string; mediaType?: string; data?: string };

async function createCodexInput(
  prompt: string,
  images: IncomingImage[]
): Promise<{ input: Input; cleanup: () => Promise<void> }> {
  const validImages = images.filter(
    (img): img is { name?: string; mediaType: string; data: string } =>
      typeof img?.mediaType === "string" &&
      img.mediaType.startsWith("image/") &&
      typeof img.data === "string" &&
      img.data.length > 0
  );
  if (validImages.length === 0) {
    return { input: prompt, cleanup: async () => {} };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-codex-"));
  const input: UserInput[] = prompt.trim()
    ? [{ type: "text", text: prompt }]
    : [];

  for (const img of validImages) {
    const ext = IMAGE_EXT_BY_MIME[img.mediaType.toLowerCase()];
    if (!ext) {
      throw new Error(`unsupported image type: ${img.mediaType}`);
    }
    const buf = Buffer.from(img.data, "base64");
    if (buf.length === 0 || buf.length > MAX_CODEX_IMAGE_BYTES) {
      throw new Error(
        `image ${img.name ?? ""} exceeds ${MAX_CODEX_IMAGE_BYTES} bytes`
      );
    }
    const file = path.join(dir, `${randomUUID()}${ext}`);
    await fs.writeFile(file, buf, { mode: 0o600 });
    input.push({ type: "local_image", path: file });
  }

  return {
    input,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
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
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" && body.clientTurnId
      ? body.clientTurnId
      : undefined;
  const cwd = expandHome(body.cwd || process.env.CC_WEBUI_CWD);
  const model: string | undefined =
    typeof body.model === "string" ? body.model : undefined;
  const effort: string | undefined =
    typeof body.effort === "string" ? body.effort : undefined;
  const permissionMode: string | undefined =
    typeof body.permissionMode === "string" ? body.permissionMode : undefined;
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

  const entry: InFlightCodexChat = {
    reqId,
    clientTurnId,
    threadId,
    messages: [],
    subscribers: new Set(),
    status: "running",
    cancelRequested: false,
    abort: new AbortController(),
  };
  if (threadId) activeCodexChats.set(threadId, entry);
  if (clientTurnId) activeCodexChatsByClientTurn.set(clientTurnId, entry);

  const fanout = fanoutFactory(entry);

  (async () => {
    let cleanupInput: (() => Promise<void>) | undefined;
    const turnEvents: unknown[] = [];
    try {
      const codex = new Codex();
      const { input, cleanup } = await createCodexInput(prompt, rawImages);
      cleanupInput = cleanup;
      const { sandboxMode, approvalPolicy } = mapPermissionMode(permissionMode);
      const threadOptions = {
        model,
        workingDirectory: cwd,
        skipGitRepoCheck: true,
        sandboxMode,
        approvalPolicy,
        modelReasoningEffort: mapEffort(effort),
      };
      const thread = threadId
        ? codex.resumeThread(threadId, threadOptions)
        : codex.startThread(threadOptions);
      const { events } = await thread.runStreamed(input, {
        signal: entry.abort.signal,
      });

      let eventCount = 0;
      for await (const ev of events) {
        if (entry.cancelRequested) break;
        eventCount++;
        if (eventCount <= 20 || eventCount % 50 === 0) {
          console.log(`[codex ${reqId}] event #${eventCount} ${ev.type} @${elapsed()}`);
        }
        if (ev.type === "thread.started") {
          entry.threadId = ev.thread_id;
          activeCodexChats.set(ev.thread_id, entry);
        }
        turnEvents.push(ev);
        fanout("codex_event", JSON.stringify(ev));
      }

      console.log(
        `[codex ${reqId}] ${entry.cancelRequested ? "cancelled" : "done"} events=${eventCount} in ${elapsed()}`
      );
      entry.status = "done";
      fanout("done", "");
    } catch (err) {
      if (entry.cancelRequested) {
        entry.status = "done";
        fanout("done", "");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      turnEvents.push({ type: "error", message });
      console.error(`[codex ${reqId}] ERROR at ${elapsed()}:`, err);
      entry.status = "error";
      entry.errorMsg = message;
      fanout("error", JSON.stringify({ message }));
    } finally {
      if (entry.threadId && turnEvents.length > 0) {
        await appendCodexTurn({
          sessionId: entry.threadId,
          cwd,
          prompt,
          startedAt,
          events: turnEvents,
        }).catch((err) => {
          console.error(`[codex ${reqId}] failed to persist session:`, err);
        });
      }
      if (cleanupInput) {
        await cleanupInput().catch(() => {});
      }
      for (const sub of [...entry.subscribers]) sub.close();
      removeEntryIfSelf(entry);
    }
  })().catch((err) =>
    console.error(`[codex ${reqId}] unhandled in detached task:`, err)
  );

  return streamSSEUnbuffered(c, async (stream) => {
    await attachStreamToEntry(stream, entry);
  });
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
  return c.json({ sessionIds: Array.from(activeCodexChats.keys()) });
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
    await attachStreamToEntry(stream, entry);
  });
});

export { codexChat };
