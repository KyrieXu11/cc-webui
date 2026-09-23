// Enforces server/auth/policy.ts. Registered once, before every route.
//
// Fail-closed by construction: a route with no policy entry is REFUSED, not
// waved through. That matters here more than usual — the underlying stores are
// shared and unscoped, so forgetting a check leaks rather than locks.

import type { Context, MiddlewareHandler } from "hono";
import { identifyRequest } from "./identify.ts";
import { policyFor, type OwnsSpec, type PathSpec, type ValueSource } from "./policy.ts";
import { canAccessResource } from "./ownership.ts";
import { getAllowedPaths, type User } from "./users.ts";
import { PathNotAllowedError, assertCanOpen } from "./paths.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_KEY = "__ccWebuiUser";

// Memoised so handlers can ask again without a second cookie parse + lookup.
export function currentUser(c: Context): User | null {
  const cached = (c as unknown as Record<string, unknown>)[USER_KEY];
  if (cached !== undefined) return cached as User | null;
  const user = identifyRequest(c);
  (c as unknown as Record<string, unknown>)[USER_KEY] = user;
  return user;
}

// Role check for the handful of decisions that are not route-level and so
// cannot live in policy.ts — currently only "which permission modes may this
// caller pick" (决策 12). Route-level admin gating belongs in the table.
export function isAdmin(c: Context): boolean {
  return currentUser(c)?.role === "admin";
}

// The route this request will actually reach. Hono populates matchedRoutes
// before the middleware chain runs; the middleware's own catch-all entry is
// excluded.
function targetRoute(c: Context): { method: string; path: string } | null {
  const matched = c.req.matchedRoutes ?? [];
  for (let i = matched.length - 1; i >= 0; i--) {
    const r = matched[i] as { method?: string; path?: string };
    if (!r?.path || r.path === "/*") continue;
    return { method: r.method ?? c.req.method, path: r.path };
  }
  return null;
}

// c.req.param() is empty inside a "/*" middleware — the params belong to the
// middleware's own route, not the target's — so extract them by hand.
export function extractParams(
  pattern: string,
  actualPath: string,
): Record<string, string> {
  const pat = pattern.split("/");
  const act = actualPath.split("/");
  const out: Record<string, string> = {};
  if (pat.length !== act.length) return out;
  for (let i = 0; i < pat.length; i++) {
    if (!pat[i].startsWith(":")) continue;
    const name = pat[i].slice(1);
    try {
      out[name] = decodeURIComponent(act[i]);
    } catch {
      out[name] = act[i];
    }
  }
  return out;
}

async function valueFrom(
  c: Context,
  source: ValueSource,
  key: string,
  params: Record<string, string>,
): Promise<string | undefined> {
  if (source === "param") return params[key];
  if (source === "query") return c.req.query(key) ?? undefined;
  // Hono memoises the parsed body, so reading it here does not starve the
  // handler.
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : undefined;
}

export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const target = targetRoute(c);
    // Nothing matched — let Hono produce its 404 rather than inventing a 403.
    if (!target) return next();

    const policy = policyFor(target.method, target.path);
    if (!policy) {
      console.error(
        `[cc-webui] auth: no policy for ${target.method} ${target.path} — refusing. ` +
          "Add an entry to server/auth/policy.ts.",
      );
      return c.json({ error: "route has no authorization policy" }, 403);
    }

    const user = currentUser(c);

    if (policy.auth !== "public") {
      if (!user) return c.json({ error: "authentication required" }, 401);
      if (policy.auth === "admin" && user.role !== "admin") {
        return c.json({ error: "forbidden" }, 403);
      }
    }
    if (!user) return next(); // public route, anonymous caller

    const params = extractParams(target.path, c.req.path);

    if (policy.owns) {
      const denial = await checkOwnership(c, policy.owns, params, user);
      if (denial) return denial;
    }

    if (policy.paths) {
      const denial = await checkPaths(c, policy.paths, params, user);
      if (denial) return denial;
    }

    return next();
  };
}

async function checkOwnership(
  c: Context,
  spec: OwnsSpec,
  params: Record<string, string>,
  user: User,
): Promise<Response | null> {
  const id = await valueFrom(c, spec.from, spec.key, params);
  if (!id) {
    if (spec.optional) return null;
    return c.json({ error: `${spec.key} required` }, 400);
  }
  // Format first, and for everyone: an admin skipping the ownership check must
  // not also skip this.
  if (spec.uuid !== false && !UUID_RE.test(id)) {
    return c.json({ error: `malformed ${spec.key}` }, 400);
  }
  if (!canAccessResource(user, id, spec.access ?? "owner")) {
    // 404 rather than 403: whether a resource exists is itself information.
    return c.json({ error: "not found" }, 404);
  }
  return null;
}

async function checkPaths(
  c: Context,
  specs: PathSpec[],
  params: Record<string, string>,
  user: User,
): Promise<Response | null> {
  const patterns = getAllowedPaths(user.id);
  for (const spec of specs) {
    let raw = await valueFrom(c, spec.from, spec.key, params);
    if (!raw && spec.fallback === "serverCwd") {
      // Mirror of the handlers' own default (chat.ts / codex-chat.ts /
      // groups.ts): body.cwd || CC_WEBUI_CWD || process.cwd().
      raw = process.env.CC_WEBUI_CWD || process.cwd();
    }
    if (!raw) {
      if (spec.optional) continue;
      return c.json({ error: `${spec.key} required` }, 400);
    }
    try {
      await assertCanOpen(raw, patterns);
    } catch (err) {
      if (err instanceof PathNotAllowedError) {
        return c.json(
          {
            error: "path not allowed",
            // Told plainly: this is a guardrail an admin configures, not a
            // secret to hide.
            detail: `${raw} is outside the folders your account may open`,
          },
          403,
        );
      }
      throw err;
    }
  }
  return null;
}
