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
  mode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
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

export type GroupTurnEntry = {
  id: string;
  ts: number;
  type:
    | "user"
    | "assistant"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "permission"
    | "summary"
    | "error";
  agent: "user" | GroupAgentId;
  recipients?: GroupAgentId[];
  text?: string;
  images?: ImageAttachment[];
  meta?: { turnId?: string; pipelineStep?: number };
};

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
