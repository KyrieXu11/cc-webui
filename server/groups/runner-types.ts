import type { AgentId } from "./store.ts";
import type { ChatEvent } from "../../src/lib/types.ts";
import type { LarkMcpContext } from "../mcp-context.ts";

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
      // SDK session id for this agent's run. On the first turn it's
      // the freshly-issued one; on resumed turns it's whatever the SDK
      // emits back (usually unchanged). Orchestrator persists this to
      // runtime.json so the next turn can pass it as `resume:`.
      sessionId?: string;
      // Set when the run failed specifically because `resume:` pointed at a
      // session the SDK no longer has ("No conversation found with session
      // ID ..."). Signals the orchestrator to forget the persisted id and
      // retry once with a fresh session + full history instead of bricking.
      sessionNotFound?: boolean;
    };

export type RunnerCtx = {
  gid: string;
  turnId: string;
  agentId: AgentId;
  signal: AbortSignal;
  // Fanout for permission lifecycle events; orchestrator wraps these with
  // {agent, turnId} when re-emitting on the group SSE channel.
  emitPermission: (payload: unknown) => void;
  // Pre-existing SDK session id, if any. When present, the runner
  // passes it to the SDK as `resume:` and only sends the catchup
  // prompt (peer replies + new user message) instead of full history.
  resumeSessionId?: string;
  // Adapter-supplied MCP context (currently Feishu/Lark send tools), stored
  // behind the per-turn bearer token the HTTP MCP routes authenticate with.
  //
  // Both providers consume it the same way now. Claude used to additionally
  // receive an in-process SDK server (`extraMcpServers`); that path went away
  // with the SDK, which is what collapsed AGENTS.md's "two MCP stacks" into
  // one.
  codexMcp?: {
    lark?: LarkMcpContext;
  };
};
