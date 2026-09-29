import type { MemoryCapability } from "./project-memory/runtime.ts";
import type * as lark from "@larksuiteoapi/node-sdk";
import type { WakeupSlot } from "./wakeup.ts";

// Per-turn context behind a bearer token, consumed by the HTTP MCP routes.
//
// Originally Codex-only (Codex reaches MCP over HTTP, unlike the SDK's
// in-process servers). The CLI migration points Claude at the same routes, so
// this is no longer provider-specific — hence the neutral naming.
//
// Everything here lives in THIS process: the token carries identity, never
// state across a process boundary. That is exactly what makes the HTTP hop safe
// for servers whose state other parts of the app read live (the bash task
// registry, which /api/bash/tasks streams) or which are built per-turn (lark).
export type LarkMcpContext = {
  channel: lark.LarkChannel;
  defaultChatId: string;
};

interface McpSessionContext {
  token: string;
  sessionId: string;
  // The cc-webui user this turn runs as. The MCP routes are authenticated by
  // the token alone (they never see a login cookie), so without this the
  // capability is unbounded by the account that triggered it — every tool call
  // would carry the union of everyone's permissions. Resolved by the turn's
  // starter: the logged-in caller for web turns, server/auth/actor.ts for the
  // ones that begin outside a request (Feishu).
  ownerId?: string;
  cwd?: string;
  lark?: LarkMcpContext;
  // Foreground bash lifecycle events are pushed into the owning turn's SSE
  // fanout so clients can track which fgId is pending (Ctrl+B detaches the
  // most recent). Only the Claude/web path sets this.
  onForegroundEvent?: (event: string, data: string) => void;
  // Backs the `schedule` MCP server: one pending wakeup per turn.
  wakeupSlot?: WakeupSlot;
  projectMemory?: MemoryCapability;
  onMemoryUpdated?: () => void;
  createdAt: number;
}

const contexts = new Map<string, McpSessionContext>();

export function registerMcpSessionContext(opts: {
  token: string;
  sessionId: string;
  ownerId?: string;
  cwd?: string;
  lark?: LarkMcpContext;
  onForegroundEvent?: (event: string, data: string) => void;
  wakeupSlot?: WakeupSlot;
  projectMemory?: MemoryCapability;
  onMemoryUpdated?: () => void;
}): void {
  contexts.set(opts.token, {
    token: opts.token,
    sessionId: opts.sessionId,
    ownerId: opts.ownerId,
    cwd: opts.cwd,
    lark: opts.lark,
    onForegroundEvent: opts.onForegroundEvent,
    wakeupSlot: opts.wakeupSlot,
    projectMemory: opts.projectMemory,
    onMemoryUpdated: opts.onMemoryUpdated,
    createdAt: Date.now(),
  });
}

export function updateMcpSession(
  token: string,
  sessionId: string
): void {
  const ctx = contexts.get(token);
  if (ctx) ctx.sessionId = sessionId;
}

// Called when a token's context goes away, so holders of per-token resources
// (the HTTP MCP routes cache one McpServer + transport per token) can tear them
// down. Without this the routes would have to build a fresh server per HTTP
// request and could never close it.
type Disposer = (token: string) => void;
const disposers: Disposer[] = [];

export function addMcpContextDisposer(fn: Disposer): void {
  disposers.push(fn);
}

export function unregisterMcpSessionContext(token: string): void {
  contexts.delete(token);
  for (const d of disposers) {
    try {
      d(token);
    } catch {
      /* a failing disposer must not block the others */
    }
  }
}

export function getMcpSessionContext(
  token: string | null
): McpSessionContext | undefined {
  if (!token) return undefined;
  return contexts.get(token);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
