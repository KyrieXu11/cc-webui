// Permission vocabulary, declared locally.
//
// These are currently imported from `@anthropic-ai/claude-agent-sdk`
// (`server/shared/permission-flow.ts:1`). The CLI migration drops that
// dependency, so the shapes live here instead. Transcribed verbatim from
// the SDK's `sdk.d.ts` (v0.3.201 / CLI 2.1.201) — they describe the *CLI's*
// wire vocabulary, not an SDK invention, so they stay valid once the SDK is
// gone. If a future CLI extends them, update here.

export type PermissionBehavior = "allow" | "deny" | "ask";

export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

// cc-webui's UI exposes only a subset of these (see src/lib/settings.ts
// MODE_OPTIONS); `dontAsk` is reachable only through the Feishu /mode command.
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

export type PermissionUpdate =
  | {
      type: "addRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "replaceRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "removeRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "setMode";
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "addDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    }
  | {
      type: "removeDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    };
