// The single place a request's identity is established.
//
// Everything that needs to know who is calling goes through here, so switching
// to a reverse proxy that injects the user (Caddy / oauth2-proxy / Tailscale)
// means editing this one function — see docs/user-permissions.md, decision 2.

import type { Context } from "hono";
import { getUserById, type User } from "./users.ts";
import { SESSION_COOKIE, parseCookie, readSession } from "./session.ts";

export function identifyRequest(c: Context): User | null {
  const token = parseCookie(c.req.header("cookie"), SESSION_COOKIE);
  const userId = readSession(token);
  if (!userId) return null;
  // A cookie can outlive the account it names — the cost of having no
  // server-side session table (decision 13).
  return getUserById(userId);
}

// True when the request reached us over TLS, directly or through a proxy that
// says so. Decides whether the session cookie gets `Secure`.
export function isSecureRequest(c: Context): boolean {
  if (c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https") {
    return true;
  }
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}
