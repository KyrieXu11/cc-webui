// Feature flags, read from the environment.
//
// Group chat — more than one agent speaking inside a single turn — is opt-in.
// The design is still immature, so a default install exposes only the
// single-agent surfaces: web solo chat (server/chat.ts, codex-chat.ts) and
// Feishu solo sessions. The session engine in server/groups/ stays loaded
// either way, because Feishu's 1-participant sessions run on it; this flag
// gates the *2-participant capability*, not the engine.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function groupsEnabled(): boolean {
  const raw = process.env.CC_WEBUI_GROUPS_ENABLED;
  return !!raw && TRUTHY.has(raw.trim().toLowerCase());
}

export function projectMemoryEnabled(): boolean {
  return TRUTHY.has(process.env.CC_WEBUI_PROJECT_MEMORY_ENABLED?.trim().toLowerCase() ?? "");
}
