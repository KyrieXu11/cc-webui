// The single place a request's identity is established.
//
// Everything that needs to know who is calling goes through here, so switching
// to a reverse proxy that injects the user (Caddy / oauth2-proxy / Tailscale)
// means editing this one function — see docs/user-permissions.md, decision 2.

import type { Context } from "hono";
import { getUserById, type User } from "./users.ts";
import { SESSION_COOKIE, parseCookie, readSession } from "./session.ts";

// Same resolution, minus Hono. The device WebSocket (docs/desktop-client.md
// 决策 14: Electron 主进程读渲染进程登录后的 cookie 开 WS) is handled on the
// node http.Server `upgrade` event, where there is no Context — only
// `req.headers.cookie`, i.e. exactly this `string | undefined`.
//
// The upgrade handler could have called parseCookie/readSession/getUserById
// itself, which is what makes this function look redundant. It isn't: doing
// that would turn the sentence at the top of this file into a lie, and the
// next auth change (proxy-injected identity, a server-side session table)
// would silently miss the WS path. Identity stays established in one place.
export function identifyCookieHeader(header: string | undefined): User | null {
  const token = parseCookie(header, SESSION_COOKIE);
  const userId = readSession(token);
  if (!userId) return null;
  // A cookie can outlive the account it names — the cost of having no
  // server-side session table (decision 13).
  return getUserById(userId);
}

export function identifyRequest(c: Context): User | null {
  return identifyCookieHeader(c.req.header("cookie"));
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
