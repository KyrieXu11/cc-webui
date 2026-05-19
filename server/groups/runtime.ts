import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ensureGroupDir,
  groupDir,
  type AgentId,
} from "./store.ts";

// Hidden per-group runtime state. Holds native session ids that we use
// to resume the underlying SDK session each turn so prompt caching
// stays warm across the conversation. Users never see this file via
// the UI; canonical jsonl remains the source of truth for what the
// conversation contains.

export type AgentRuntimeState = {
  // Claude Agent SDK session id; populated after the agent's first turn.
  // We pass it to query() with `resume:` on subsequent turns.
  sessionId?: string;
};

export type GroupRuntimeState = {
  agents: Partial<Record<AgentId, AgentRuntimeState>>;
  updatedAt: number;
};

function runtimePath(gid: string): string {
  return path.join(groupDir(gid), "runtime.json");
}

export async function readRuntime(gid: string): Promise<GroupRuntimeState> {
  try {
    const raw = await fs.readFile(runtimePath(gid), "utf8");
    const parsed = JSON.parse(raw) as Partial<GroupRuntimeState>;
    return {
      agents: parsed?.agents ?? {},
      updatedAt: parsed?.updatedAt ?? 0,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { agents: {}, updatedAt: 0 };
    }
    throw err;
  }
}

export async function writeRuntime(
  gid: string,
  state: GroupRuntimeState,
): Promise<void> {
  await ensureGroupDir(gid);
  const tmp = runtimePath(gid) + ".tmp";
  await fs.writeFile(
    tmp,
    JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2),
  );
  await fs.rename(tmp, runtimePath(gid));
}

export async function setAgentSessionId(
  gid: string,
  agentId: AgentId,
  sessionId: string,
): Promise<void> {
  const cur = await readRuntime(gid);
  const prev = cur.agents[agentId]?.sessionId;
  if (prev === sessionId) return;
  cur.agents[agentId] = { ...(cur.agents[agentId] ?? {}), sessionId };
  await writeRuntime(gid, cur);
}

export async function getAgentSessionId(
  gid: string,
  agentId: AgentId,
): Promise<string | undefined> {
  const cur = await readRuntime(gid);
  return cur.agents[agentId]?.sessionId;
}

// Forget the persisted SDK session id for this agent so the next turn
// starts a brand new session (no `resume:`). Used when model changes,
// since resuming a different model on the same session id mis-routes.
export async function clearAgentSessionId(
  gid: string,
  agentId: AgentId,
): Promise<void> {
  const cur = await readRuntime(gid);
  if (!cur.agents[agentId]?.sessionId) return;
  cur.agents[agentId] = { ...(cur.agents[agentId] ?? {}), sessionId: undefined };
  await writeRuntime(gid, cur);
}
