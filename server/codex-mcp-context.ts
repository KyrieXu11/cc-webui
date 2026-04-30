interface CodexMcpContext {
  token: string;
  sessionId: string;
  cwd?: string;
  createdAt: number;
}

const contexts = new Map<string, CodexMcpContext>();

export function registerCodexMcpContext(opts: {
  token: string;
  sessionId: string;
  cwd?: string;
}): void {
  contexts.set(opts.token, {
    token: opts.token,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    createdAt: Date.now(),
  });
}

export function updateCodexMcpSession(
  token: string,
  sessionId: string
): void {
  const ctx = contexts.get(token);
  if (ctx) ctx.sessionId = sessionId;
}

export function unregisterCodexMcpContext(token: string): void {
  contexts.delete(token);
}

export function getCodexMcpContext(
  token: string | null
): CodexMcpContext | undefined {
  if (!token) return undefined;
  return contexts.get(token);
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

