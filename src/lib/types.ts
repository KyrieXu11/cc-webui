export type StepStatus = "ok" | "pending" | "error";

export type PermissionDecision =
  | "allow"
  | "allow_session"
  | "allow_tool_session"
  | "deny";

export type ImageAttachment = {
  name?: string;
  mediaType: string;
  data: string;
};

export type GroupAgentId = "claude" | "codex";

export type GroupParticipant = {
  id: GroupAgentId;
  model: string;
  mode?: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto" | "dontAsk";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;
  skills: string[];
  mcpServers: string[];
};

export type GroupConfig = {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  participants: GroupParticipant[];
  pipeline: GroupAgentId[];
};

// Each canonical entry wraps a ChatEvent (the shape MessageList renders)
// plus the agent that produced it and per-turn meta.
export type GroupTurnEntry = {
  agent: "user" | GroupAgentId;
  ts: number;
  event: ChatEvent;
  meta?: {
    turnId?: string;
    pipelineStep?: number;
    recipients?: GroupAgentId[];
    error?: string;
    // When the user sent this message as a "quote-reply" to a prior
    // agent message, we stash the quoted text + source agent here so
    // the bubble can render the quote block visually and the prompt
    // builder can prepend "> [来自 X]" context for the recipients.
    quote?: { agent: GroupAgentId; text: string };
  };
};

export type GroupQuote = { agent: GroupAgentId; text: string };

export type GroupIndexRow = {
  id: string;
  title: string;
  cwd: string;
  lastTs: number;
  participantSummary: string;
  lastSnippet: string;
  inFlight: boolean;
};

export type GroupSseEvent =
  | {
      type: "turn_begin";
      turnId: string;
      userText: string;
      recipients: GroupAgentId[];
      quote?: GroupQuote;
    }
  | {
      type: "agent_begin";
      turnId: string;
      agent: GroupAgentId;
      step: number;
      totalSteps: number;
    }
  | {
      type: "agent_event";
      turnId: string;
      agent: GroupAgentId;
      payload: any;
    }
  | {
      type: "agent_end";
      turnId: string;
      agent: GroupAgentId;
      ok: boolean;
      error?: string;
    }
  | { type: "turn_end"; turnId: string; ok: boolean; error?: string }
  | {
      type: "permission_request";
      turnId: string;
      agent: GroupAgentId;
      id: string;
      tool: string;
      input: Record<string, any>;
      title?: string;
      displayName?: string;
      description?: string;
      hasSessionPermissionSuggestions?: boolean;
      toolUseId?: string;
    };

export type ChatEvent =
  | {
      id: string;
      type: "user";
      text: string;
      images?: ImageAttachment[];
    }
  | { id: string; type: "assistant"; text: string }
  | { id: string; type: "thinking"; text: string }
  | {
      id: string;
      type: "step";
      tool: string;
      arg?: string;
      status: StepStatus;
      input?: Record<string, any>;
      output?: string;
    }
  | {
      id: string;
      type: "permission";
      permissionId: string;
      tool: string;
      input: Record<string, any>;
      resolved?: PermissionDecision;
      stale?: boolean;
      toolUseId?: string;
      title?: string;
      displayName?: string;
      description?: string;
      hasSessionPermissionSuggestions?: boolean;
    }
  | {
      id: string;
      type: "summary";
      title: string;
      body: string;
    };
