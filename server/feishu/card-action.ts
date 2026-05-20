import type * as lark from "@larksuiteoapi/node-sdk";
import {
  resolvePermission,
  type PermissionDecision,
} from "../permission.ts";
import type { BotConfig } from "./config.ts";

// Receives Feishu card-action events for permission cards rendered by
// bridge.ts and forwards the user's decision to cc-webui's pending
// awaitPermission, which unblocks the Claude SDK's canUseTool callback.
//
// The matching `permission_resolved` payload that claude-runner emits
// right after resolvePermission is what triggers the card to be patched
// with the final state (handled by bridge.ts, not here).
export function handleCardAction(
  bot: BotConfig,
  evt: lark.CardActionEvent,
): void {
  const value = evt.action?.value as
    | { kind?: string; id?: string; decision?: string }
    | undefined;
  if (!value || value.kind !== "permission") return;

  const id = value.id;
  const decisionStr = value.decision;
  if (!id || !decisionStr) return;

  const operatorName = evt.operator?.name || evt.operator?.openId || "user";

  let decision: PermissionDecision;
  switch (decisionStr) {
    case "allow":
      decision = { behavior: "allow" };
      break;
    case "allow_session":
      decision = { behavior: "allow_session" };
      break;
    case "allow_tool_session":
      decision = { behavior: "allow_tool_session" };
      break;
    case "deny":
      decision = { behavior: "deny", message: `denied by ${operatorName}` };
      break;
    default:
      console.warn(
        `[feishu ${bot.key} cardAction] unknown decision: ${decisionStr}`,
      );
      return;
  }

  const ok = resolvePermission(id, decision);
  if (ok) {
    console.log(
      `[feishu ${bot.key} cardAction] permission ${id} → ${decisionStr} by ${operatorName}`,
    );
  } else {
    // Either already resolved (race with timeout / abort) or unknown id.
    // bridge.ts won't get a fresh permission_resolved for this case, so the
    // card stays in pending state — acceptable; a stale resolved is what the
    // user expects to see.
    console.warn(
      `[feishu ${bot.key} cardAction] permission ${id} not pending (stale/already-resolved)`,
    );
  }
}
