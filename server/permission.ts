import { Hono } from "hono";

type PendingEntry = {
  resolve: (decision: PermissionDecision) => void;
  reject: (err: Error) => void;
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
  signal: AbortSignal
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

export function resolvePermission(
  id: string,
  decision: PermissionDecision
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
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
  const ok = resolvePermission(id, decision);
  return c.json({ ok });
});

export { permissionRoute };
