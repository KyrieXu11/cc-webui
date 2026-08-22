// Login / logout / whoami. The only routes that are reachable unauthenticated.

import { Hono } from "hono";
import { authenticate, getAllowedPaths } from "./auth/users.ts";
import {
  clearedSessionCookie,
  issueSession,
  sessionCookie,
} from "./auth/session.ts";
import { identifyRequest, isSecureRequest } from "./auth/identify.ts";

const authRoutes = new Hono();

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return c.json({ error: "username and password required" }, 400);
  }
  const user = authenticate(username, password);
  if (!user) {
    // Deliberately identical for "no such account" and "wrong password".
    return c.json({ error: "invalid credentials" }, 401);
  }
  c.header(
    "set-cookie",
    sessionCookie(issueSession(user.id), isSecureRequest(c)),
  );
  return c.json({ user, allowedPaths: getAllowedPaths(user.id) });
});

authRoutes.post("/logout", (c) => {
  c.header("set-cookie", clearedSessionCookie());
  return c.json({ ok: true });
});

// 200 with `user: null` rather than 401 — "nobody is logged in" is the normal
// first-load state, not an error the frontend should have to catch.
authRoutes.get("/me", (c) => {
  const user = identifyRequest(c);
  if (!user) return c.json({ user: null });
  return c.json({ user, allowedPaths: getAllowedPaths(user.id) });
});

export { authRoutes };
