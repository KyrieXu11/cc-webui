import { Hono } from "hono";
import { currentUser } from "./auth/middleware.ts";

type PendingEntry = {
  resolve: (decision: PermissionDecision) => void;
  reject: (err: Error) => void;
  // Who is allowed to answer this card.
  //
  // The map is global and keyed only by a random id, so without this any
  // authenticated user could resolve anyone else's permission prompt — and the
  // Feishu card handler could resolve a prompt raised in a different chat.
  ownerId?: string;
  // For prompts raised inside a group turn: the gid. The Feishu card handler
  // answers by gid, because a card click carries a chat, not a cc-webui user.
  gid?: string;
};

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "allow_session" }
  | { behavior: "allow_tool_session" }
  | { behavior: "deny"; message: string };

const pending = new Map<string, PendingEntry>();

const PERMISSION_TIMEOUT_MS = Number(
  process.env.CC_WEBUI_PERMISSION_TIMEOUT_MS ?? 10 * 60 * 1000
);

export function awaitPermission(
  id: string,
  signal: AbortSignal,
  scope: { ownerId?: string; gid?: string } = {}
): Promise<PermissionDecision> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(new Error("aborted")));
    const onTimeout = () =>
      settle(() =>
        resolve({
          behavior: "deny",
          message: `由于用户 ${Math.round(
            PERMISSION_TIMEOUT_MS / 1000
          )}s 没有反应，所以拒绝执行`,
        })
      );

    const entry: PendingEntry = {
      resolve: (d) => settle(() => resolve(d)),
      reject: (e) => settle(() => reject(e)),
      ownerId: scope.ownerId,
      gid: scope.gid,
    };
    pending.set(id, entry);

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onTimeout, PERMISSION_TIMEOUT_MS);
  });
}

// `by` identifies the answerer. Omitting it entirely is only for internal
// callers that have already established the right to answer.
//
// Returns false both for "no such prompt" and "not yours" — deliberately
// indistinguishable, since the id space is the only thing protecting one user's
// prompts from another's guesses.
export function resolvePermission(
  id: string,
  decision: PermissionDecision,
  by?: { userId?: string; isAdmin?: boolean; gid?: string }
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (by) {
    const byUser =
      by.isAdmin === true ||
      (by.userId !== undefined && entry.ownerId === by.userId);
    const byGid = by.gid !== undefined && entry.gid === by.gid;
    if (!byUser && !byGid) return false;
  }
  pending.delete(id);
  entry.resolve(decision);
  return true;
}

const permissionRoute = new Hono();

permissionRoute.post("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const behavior = body.behavior;
  if (
    behavior !== "allow" &&
    behavior !== "allow_session" &&
    behavior !== "allow_tool_session" &&
    behavior !== "deny"
  ) {
    return c.json(
      {
        error:
          "behavior must be allow, allow_session, allow_tool_session, or deny",
      },
      400
    );
  }
  const decision: PermissionDecision =
    behavior === "allow"
      ? { behavior: "allow" }
      : behavior === "allow_session"
        ? { behavior: "allow_session" }
        : behavior === "allow_tool_session"
          ? { behavior: "allow_tool_session" }
        : { behavior: "deny", message: body.message || "user denied" };
  const me = currentUser(c);
  const ok = resolvePermission(id, decision, {
    userId: me?.id,
    isAdmin: me?.role === "admin",
  });
  return c.json({ ok });
});

export { permissionRoute };
