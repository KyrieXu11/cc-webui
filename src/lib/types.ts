export type StepStatus = "ok" | "pending" | "error";

export type ChatEvent =
  | { id: string; type: "user"; text: string }
  | { id: string; type: "assistant"; text: string }
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
      question: string;
      options: string[];
    }
  | {
      id: string;
      type: "summary";
      title: string;
      body: string;
    };
