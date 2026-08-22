import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { currentUser } from "./auth/middleware.ts";
import { canSeeTaskSession } from "./auth/scope.ts";
import {
  listBackgroundTasks,
  getBackgroundTaskById,
  killBackgroundTaskById,
  subscribeListChanges,
  subscribeTaskOutput,
  detachForegroundToBackground,
  listForegroundInvocations,
  type TaskOutputEvent,
} from "./bash-mcp.ts";

const route = new Hono();

const KEEPALIVE_MS = 25_000;

function summary(t: ReturnType<typeof listBackgroundTasks>[number]) {
  return {
    id: t.id,
    command: t.command,
    cwd: t.cwd ?? null,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    exitCode: t.exitCode,
    status: t.status,
    truncated: t.truncated,
    stdoutBytes: t.stdout.length,
    stderrBytes: t.stderr.length,
    endReason: t.endReason,
  };
}

// `visible` is applied on the raw tasks (which carry sessionId) before they are
// summarised — the summary drops sessionId, and the caller-supplied filter was
// never a security boundary: it defaulted to "everything".
function listPayload(
  filter:
    | { sessionId?: string | null; sessionPrefix?: string }
    | undefined,
  visible: (sessionId: string | undefined) => boolean,
) {
  const tasks = listBackgroundTasks(filter)
    .filter((t) => visible(t.sessionId))
    .map(summary);
  const running = tasks.filter((t) => t.status === "running").length;
  return { tasks, running, total: tasks.length };
}

function parseFilter(c: {
  req: { query: (k: string) => string | undefined };
}): { sessionId?: string | null; sessionPrefix?: string } | undefined {
  const sessionIdRaw = c.req.query("sessionId");
  const prefixRaw = c.req.query("sessionPrefix");
  if (prefixRaw) return { sessionPrefix: prefixRaw };
  if (sessionIdRaw === undefined) return undefined;
  // Query present (even empty) → strict filter; unset tasks match empty.
  return { sessionId: sessionIdRaw === "" ? null : sessionIdRaw };
}

route.get("/", (c) => {
  const user = currentUser(c)!;
  return c.json(
    listPayload(parseFilter(c), (sid) => canSeeTaskSession(user, sid)),
  );
});

route.get("/stream", (c) => {
  const filter = parseFilter(c);
  const user = currentUser(c)!;
  const visible = (sid: string | undefined) => canSeeTaskSession(user, sid);

  return streamSSE(c, async (stream) => {
    let dirty = false;
    let closed = false;
    let wake: (() => void) | null = null;

    const ping = () => {
      if (wake) {
        const r = wake;
        wake = null;
        r();
      }
    };
    const markDirty = () => {
      dirty = true;
      ping();
    };

    const unsubscribe = subscribeListChanges(markDirty);
    const keepAlive = setInterval(ping, KEEPALIVE_MS);
    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      clearInterval(keepAlive);
      ping();
    });

    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify(listPayload(filter, visible)),
    });

    while (!closed) {
      if (!dirty) {
        await new Promise<void>((r) => {
          wake = r;
        });
        if (closed) break;
        if (!dirty) {
          // Woken by keep-alive — send a comment so the connection stays open
          // through any idle proxies.
          await stream.writeSSE({ event: "ping", data: "" });
          continue;
        }
      }
      dirty = false;
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(listPayload(filter, visible)),
      });
    }
  });
});

route.get("/:id/output", (c) => {
  const id = c.req.param("id");
  const t = getBackgroundTaskById(id);
  // 404 for both "no such task" and "not yours": task ids used to be a bare
  // global map lookup, so anyone could read anyone's output.
  if (!t || !canSeeTaskSession(currentUser(c)!, t.sessionId)) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({
    ...summary(t),
    stdout: t.stdout,
    stderr: t.stderr,
  });
});

route.post("/:id/kill", (c) => {
  const id = c.req.param("id");
  const existing = getBackgroundTaskById(id);
  if (!existing || !canSeeTaskSession(currentUser(c)!, existing.sessionId)) {
    return c.json({ error: "not_found" }, 404);
  }
  const result = killBackgroundTaskById(id);
  if (!result.ok && result.reason === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(result);
});

route.get("/:id/stream", (c) => {
  const id = c.req.param("id");
  const t = getBackgroundTaskById(id);
  if (!t || !canSeeTaskSession(currentUser(c)!, t.sessionId)) {
    return c.json({ error: "not_found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    type QueueItem = { event: string; data: string };
    const queue: QueueItem[] = [];
    let closed = false;
    let resolveNext: (() => void) | null = null;

    const wake = () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };
    const push = (event: string, data: string) => {
      queue.push({ event, data });
      wake();
    };

    await stream.writeSSE({
      event: "init",
      data: JSON.stringify({
        ...summary(t),
        stdout: t.stdout,
        stderr: t.stderr,
      }),
    });

    if (t.status !== "running") {
      await stream.writeSSE({ event: "done", data: "" });
      return;
    }

    const unsubscribe = subscribeTaskOutput(id, (ev: TaskOutputEvent) => {
      if (ev.type === "stdout" || ev.type === "stderr") {
        push(ev.type, JSON.stringify({ chunk: ev.chunk }));
      } else if (ev.type === "status") {
        push(
          "status",
          JSON.stringify({
            status: ev.status,
            exitCode: ev.exitCode,
            endReason: ev.endReason,
            finishedAt: ev.finishedAt,
            truncated: ev.truncated,
          })
        );
      } else if (ev.type === "done") {
        push("done", "");
        closed = true;
        wake();
      }
    });
    const keepAlive = setInterval(() => {
      if (!closed) push("ping", "");
    }, KEEPALIVE_MS);
    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      clearInterval(keepAlive);
      wake();
    });

    while (!closed || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          resolveNext = r;
        });
        continue;
      }
      const msg = queue.shift()!;
      await stream.writeSSE(msg);
    }
    clearInterval(keepAlive);
  });
});

// List currently-running foreground invocations (Ctrl+B can target the latest
// one). Filtered by sessionId when provided, same semantics as /api/bash/tasks.
route.get("/foreground", (c) => {
  const sessionIdRaw = c.req.query("sessionId");
  const filter =
    sessionIdRaw === undefined
      ? undefined
      : { sessionId: sessionIdRaw === "" ? null : sessionIdRaw };
  const user = currentUser(c)!;
  return c.json({
    foreground: listForegroundInvocations(filter).filter((f) =>
      canSeeTaskSession(user, f.sessionId),
    ),
  });
});

// Detach a running foreground bash to a BackgroundTask. The foreground SDK
// tool call resolves immediately with the new bashTaskId, the model sees it
// as a normal tool result and can continue, and the proc keeps running under
// the task lifecycle.
route.post("/foreground/:fgId/detach", (c) => {
  const fgId = c.req.param("fgId");
  const user = currentUser(c)!;
  const owned = listForegroundInvocations().some(
    (f) => f.fgId === fgId && canSeeTaskSession(user, f.sessionId),
  );
  if (!owned) return c.json({ error: "not_found" }, 404);
  const result = detachForegroundToBackground(fgId);
  if (!result.ok && result.reason === "not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(result);
});

export { route as bashTasksRoute };
