import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

// Per-scope allowance sets. A "scope" is an opaque string the caller picks:
// single chat uses the SDK sessionId; group chat uses `${gid}:${agentId}`.
// Same global maps, different scope strings — they don't collide because
// sessionIds are UUIDs and group scopes contain a colon.
const allowanceByScope = new Map<string, Set<string>>();
const inputAllowanceByScope = new Map<string, Set<string>>();

export function getOrCreateAllowance(scope: string | undefined): Set<string> {
  if (!scope) return new Set<string>();
  let s = allowanceByScope.get(scope);
  if (!s) {
    s = new Set<string>();
    allowanceByScope.set(scope, s);
  }
  return s;
}

export function getOrCreateInputAllowance(
  scope: string | undefined,
): Set<string> {
  if (!scope) return new Set<string>();
  let s = inputAllowanceByScope.get(scope);
  if (!s) {
    s = new Set<string>();
    inputAllowanceByScope.set(scope, s);
  }
  return s;
}

export function clearScope(scope: string): void {
  allowanceByScope.delete(scope);
  inputAllowanceByScope.delete(scope);
}

// Re-key the allowance sets when a placeholder scope (e.g. `claude-turn-PENDING`)
// is replaced by a real one (e.g. the SDK-issued sessionId). The same Set objects
// are kept so any pending callers holding direct references continue to work.
export function relabelScope(
  oldScope: string | undefined,
  newScope: string,
  attachedTool?: Set<string>,
  attachedInput?: Set<string>,
): void {
  if (oldScope === newScope) return;
  if (!oldScope) {
    if (attachedTool) allowanceByScope.set(newScope, attachedTool);
    if (attachedInput) inputAllowanceByScope.set(newScope, attachedInput);
    return;
  }
  const tool = attachedTool ?? allowanceByScope.get(oldScope);
  if (tool && allowanceByScope.get(oldScope) === tool) {
    allowanceByScope.delete(oldScope);
  }
  if (tool) allowanceByScope.set(newScope, tool);
  const input = attachedInput ?? inputAllowanceByScope.get(oldScope);
  if (input && inputAllowanceByScope.get(oldScope) === input) {
    inputAllowanceByScope.delete(oldScope);
  }
  if (input) inputAllowanceByScope.set(newScope, input);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function permissionInputKey(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return `${toolName}:${stableStringify(input)}`;
}

export function sessionPermissionSuggestions(
  suggestions: readonly PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  return (suggestions ?? []).filter((s) => {
    if (s.destination !== "session") return false;
    if (s.type === "addRules") {
      return s.behavior === "allow" && s.rules.length > 0;
    }
    if (s.type === "addDirectories") {
      return s.directories.length > 0;
    }
    return false;
  });
}
