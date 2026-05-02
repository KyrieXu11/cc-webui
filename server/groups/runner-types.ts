import type { AgentId } from "./store.ts";

// All runner output flows as raw SDK events that the orchestrator forwards
// to the client SSE channel verbatim. The frontend's existing
// processor.ts already knows how to fold both Claude SDK messages and
// Codex thread events into chat UI state, so we don't re-implement that
// mapping here. The orchestrator separately accumulates the final
// assistant + thinking text for canonical jsonl persistence.

export type RunnerEvent =
  | { kind: "raw"; payload: unknown }
  | {
      kind: "ended";
      ok: boolean;
      error?: string;
      finalText: string;
      finalThinking: string;
    };

export type RunnerCtx = {
  gid: string;
  turnId: string;
  agentId: AgentId;
  signal: AbortSignal;
  // fanout for permission_request events; orchestrator wraps these with
  // {agent, turnId} when re-emitting on the group SSE channel.
  emitPermission: (payload: unknown) => void;
};
