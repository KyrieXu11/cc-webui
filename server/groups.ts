import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newGroupId,
  upsertIndexRow,
  removeIndexRow,
  readIndex,
  readAll,
  groupDir,
} from "./groups/store.ts";
import {
  defaultConfig,
  readConfig,
  writeConfig,
  validateConfig,
  type GroupConfig,
} from "./groups/config.ts";
import {
  startTurn,
  stopTurn,
  subscribeInFlight,
  getInFlightTurn,
  listInFlightTurns,
  type GroupSubscriber,
} from "./groups/orchestrator.ts";

const groups = new Hono();

const KEEPALIVE_MS = 15_000;

function expandHome(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function streamSSEUnbuffered(
  c: Context,
  cb: (stream: SSEStreamingApi) => Promise<void>,
): Response {
  const res = streamSSE(c, cb);
  res.headers.set("Cache-Control", "no-cache, no-transform");
  res.headers.set("X-Accel-Buffering", "no");
  return res;
}

// ============================================================
// CRUD
// ============================================================

groups.get("/", async (c) => {
  const idx = await readIndex();
  const inFlight = new Set(listInFlightTurns().map((t) => t.gid));
  // Reflect live in-flight state on the index without persisting
  return c.json({
    groups: idx.groups.map((g) => ({ ...g, inFlight: inFlight.has(g.id) })),
  });
});

groups.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = newGroupId();
  const cwd =
    expandHome(body.cwd) || process.env.CC_WEBUI_CWD || process.cwd();
  const skeleton = defaultConfig({
    id,
    title: body.title || "新群聊",
    cwd,
  });
  const cfg: GroupConfig = {
    ...skeleton,
    participants: Array.isArray(body.participants)
      ? body.participants
      : skeleton.participants,
    pipeline: Array.isArray(body.pipeline) ? body.pipeline : skeleton.pipeline,
  };
  cfg.id = id;
  validateConfig(cfg);
  await writeConfig(cfg);
  await upsertIndexRow({
    id: cfg.id,
    title: cfg.title,
    cwd: cfg.cwd,
    lastTs: Date.now(),
    participantSummary: cfg.participants
      .map((p) => (p.id === "claude" ? "Claude" : "Codex"))
      .join(" · "),
    lastSnippet: "",
    inFlight: false,
  });
  return c.json({ id });
});

groups.get("/:gid", async (c) => {
  const gid = c.req.param("gid");
  try {
    const config = await readConfig(gid);
    const messages = await readAll(gid);
    return c.json({
      config,
      messages,
      inFlight: !!getInFlightTurn(gid),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return c.json({ error: "not found" }, 404);
    }
    throw err;
  }
});

groups.patch("/:gid/config", async (c) => {
  const gid = c.req.param("gid");
  const body = await c.req.json();
  const old = await readConfig(gid);
  // cwd is locked after creation — the agents' resumed SDK sessions
  // were started under the original cwd, switching mid-conversation
  // would desync them from the canonical config. Belt + suspenders:
  // ignore any cwd in the patch body.
  const { cwd: _ignoredCwd, id: _ignoredId, createdAt: _ignoredCreated, ...patch } =
    body ?? {};
  const merged: GroupConfig = {
    ...old,
    ...patch,
    id: old.id,
    cwd: old.cwd,
    createdAt: old.createdAt,
    updatedAt: Date.now(),
  };
  validateConfig(merged);
  await writeConfig(merged);
  return c.json({ ok: true });
});

groups.delete("/:gid", async (c) => {
  const gid = c.req.param("gid");
  const turn = getInFlightTurn(gid);
  if (turn) {
    return c.json({ error: "turn in flight; stop first" }, 409);
  }
  await fs.rm(groupDir(gid), { recursive: true, force: true });
  await removeIndexRow(gid);
  return c.json({ ok: true });
});

// ============================================================
// Turn (POST starts; GET attaches to existing in-flight)
// ============================================================

groups.post("/:gid/turn", async (c) => {
  const gid = c.req.param("gid");
  const body = await c.req.json().catch(() => ({}));
  const text: string = typeof body.text === "string" ? body.text : "";
  const recipients: ("claude" | "codex" | "all")[] = Array.isArray(
    body.recipients,
  )
    ? body.recipients
    : ["all"];
  const images = Array.isArray(body.images) ? body.images : [];
  const quote =
    body.quote &&
    typeof body.quote.text === "string" &&
    (body.quote.agent === "claude" || body.quote.agent === "codex")
      ? { agent: body.quote.agent, text: body.quote.text }
      : undefined;

  let result;
  try {
    result = await startTurn({ gid, text, images, recipients, quote });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 409);
  }
  const turn = result.turn;

  return streamSSEUnbuffered(c, async (s) => {
    let closed = false;
    const sub: GroupSubscriber = {
      write: (event, data) => {
        if (closed) return;
        s.writeSSE({ event, data }).catch(() => {});
      },
      close: () => {
        closed = true;
      },
    };
    // Replay all buffered events that already happened (turn_begin etc.),
    // then follow live until close().
    for (const m of turn.buffered) {
      sub.write(m.event, m.data);
    }
    turn.subscribers.add(sub);

    // Heartbeat to keep proxies / load balancers from buffering.
    const ka = setInterval(() => {
      if (closed) return;
      s.writeSSE({ event: "ka", data: "" }).catch(() => {});
    }, KEEPALIVE_MS);

    try {
      // Wait until the turn ends.
      await new Promise<void>((resolve) => {
        const check = () => {
          if (closed || turn.status !== "running") {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    } finally {
      clearInterval(ka);
      turn.subscribers.delete(sub);
    }
  });
});

groups.get("/:gid/stream", async (c) => {
  const gid = c.req.param("gid");
  return streamSSEUnbuffered(c, async (s) => {
    let closed = false;
    const sub: GroupSubscriber = {
      write: (event, data) => {
        if (closed) return;
        s.writeSSE({ event, data }).catch(() => {});
      },
      close: () => {
        closed = true;
      },
    };
    const handle = subscribeInFlight(gid, sub);
    if (!handle) {
      await s.writeSSE({ event: "no_inflight", data: "{}" });
      return;
    }
    const ka = setInterval(() => {
      if (closed) return;
      s.writeSSE({ event: "ka", data: "" }).catch(() => {});
    }, KEEPALIVE_MS);
    try {
      await new Promise<void>((resolve) => {
        const check = () => {
          const turn = getInFlightTurn(gid);
          if (closed || !turn || turn.status !== "running") {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    } finally {
      clearInterval(ka);
      handle.detach();
    }
  });
});

groups.post("/:gid/stop", async (c) => {
  const gid = c.req.param("gid");
  const ok = stopTurn(gid);
  return c.json({ ok });
});

// ============================================================
// In-flight summary (lets sidebar paint pulse dots like single chats)
// ============================================================

groups.get("/inflight/all", async (c) => {
  return c.json({
    inflight: listInFlightTurns().map((t) => ({
      gid: t.gid,
      turnId: t.turnId,
      startedAt: t.startedAt,
    })),
  });
});

export { groups };
