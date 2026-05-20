import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
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
      // SDK session id for this agent's run. On the first turn it's
      // the freshly-issued one; on resumed turns it's whatever the SDK
      // emits back (usually unchanged). Orchestrator persists this to
      // runtime.json so the next turn can pass it as `resume:`.
      sessionId?: string;
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
  // Per-turn in-process MCP servers contributed by the caller (e.g. the
  // Feishu adapter injects a `lark` MCP holding chatId + LarkChannel so
  // Claude can send files back to the IM chat that initiated the turn).
  // Merged with built-in mcpServers in the runner; tools under these
  // namespaces are auto-allowed (they don't touch the user's filesystem).
  // Values are SDK-wrapped via `createSdkMcpServer`, NOT raw McpServer
  // instances — the SDK only accepts McpServerConfig shapes.
  extraMcpServers?: Record<string, McpSdkServerConfigWithInstance>;
};
