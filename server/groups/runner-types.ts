import type { AgentId } from "./store.ts";
import type { ChatEvent } from "../../src/lib/types.ts";

// All runner output flows as raw SDK events that the orchestrator
// forwards to the client SSE channel verbatim — the frontend's
// applySDKMessage knows how to fold both Claude and Codex events into
// the same ChatEvent shape live during a turn. The runner ALSO folds
// those same raw events server-side via the same function, exposing the
// final ChatEvent[] when the turn ends so the orchestrator can persist
// every step / assistant / thinking / permission to canonical jsonl.
// That makes a refresh after the turn ends produce the same view as
// streaming live, including tool-call timelines and edit diffs.

export type RunnerEvent =
  | { kind: "raw"; payload: unknown }
  | {
      kind: "ended";
      ok: boolean;
      error?: string;
      events: ChatEvent[];
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
