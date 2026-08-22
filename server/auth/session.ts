// Login state as a signed cookie — no server-side session table.
//
// Chosen because `tsx watch` restarts on every edit: an in-memory session table
// would log the developer out constantly. The stated cost (docs/user-permissions.md,
// decision 13) is that revocation is not immediate — a password change or a
// deleted account only takes effect when the cookie expires, or when the secret
// is rotated (delete ~/.cc-webui/cookie-secret to invalidate every session).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const SESSION_COOKIE = "cc_webui_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secretPath(): string {
  const env = process.env.CC_WEBUI_COOKIE_SECRET_FILE?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".cc-webui", "cookie-secret");
}

let cachedSecret: Buffer | null = null;

export function cookieSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const file = secretPath();
  try {
    cachedSecret = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
    if (cachedSecret.length >= 32) return cachedSecret;
  } catch {
    /* generate below */
  }
  const generated = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0600: the secret is a login bypass for every account.
  fs.writeFileSync(file, generated.toString("hex"), { mode: 0o600 });
  cachedSecret = generated;
  return cachedSecret;
}

// Tests only.
export function resetSecretCache(): void {
  cachedSecret = null;
}

function sign(payload: string): string {
  return createHmac("sha256", cookieSecret()).update(payload).digest("hex");
}

export function issueSession(userId: string, now = Date.now()): string {
  const payload = `${userId}.${now + TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the user id, or null for anything malformed, expired or unsigned.
export function readSession(
  token: string | undefined,
  now = Date.now(),
): string | null {
  if (!token) return null;
  const last = token.lastIndexOf(".");
  if (last <= 0) return null;
  const payload = token.slice(0, last);
  const providedSig = token.slice(last + 1);
  const expected = sign(payload);
  // Compare in constant time, and only after a length check — timingSafeEqual
  // throws on differing lengths.
  if (providedSig.length !== expected.length) return null;
  if (
    !timingSafeEqual(Buffer.from(providedSig, "utf8"), Buffer.from(expected, "utf8"))
  ) {
    return null;
  }
  const dot = payload.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = payload.slice(0, dot);
  const exp = Number(payload.slice(dot + 1));
  if (!Number.isFinite(exp) || exp <= now) return null;
  return userId || null;
}

// `Secure` is set only when the request actually arrived over TLS: the default
// deployment is plain http on loopback, where a Secure cookie would never be
// sent back at all.
export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
