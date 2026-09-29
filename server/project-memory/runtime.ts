import { projectMemoryEnabled } from "../features.ts";
import { resolveMemoryScope, type MemoryScope } from "./scope.ts";
import { memoryPrompt, memorySnapshot } from "./prompt.ts";
import { wrapMemoryPrompt } from "../../shared/project-memory-envelope.ts";
export type MemoryCapability = {
  scope: MemoryScope;
  writable: boolean;
  provider: "claude" | "codex";
};
export async function prepareProjectMemory(actorId: string | undefined, cwd: string, provider: "claude" | "codex", mode?: string) {
  if (!projectMemoryEnabled()) return null;
  if (!actorId) throw new Error("Project memory requires an account");
  const capability: MemoryCapability = {
    scope: await resolveMemoryScope(actorId, cwd),
    writable: mode !== "plan",
    provider
  };
  const snapshot = await memorySnapshot(capability.scope);
  return {
    capability,
    rules: memoryPrompt(capability.writable),
    wrap: (text: string, guidance = "") => wrapMemoryPrompt(snapshot, text, guidance)
  };
}
export const MEMORY_TOOLS = new Set(["mcp__memory__list", "mcp__memory__search", "mcp__memory__read", "mcp__memory__save", "mcp__memory__delete"]);
