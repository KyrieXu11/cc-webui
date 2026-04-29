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
