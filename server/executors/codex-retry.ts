import type { CodexRetryFrame } from "../../shared/codex-retry.ts";

type NativeParams = Record<string, any>;
const MODEL_ITEMS = new Set(["reasoning", "agentMessage", "commandExecution", "fileChange", "mcpToolCall", "webSearch", "imageView", "collabAgentToolCall"]);
const MODEL_DELTAS = new Set(["item/agentMessage/delta", "item/reasoning/summaryTextDelta"]);

export class CodexRetryTracker {
  private retryingTurn?: string;
  private seenItems = new Set<string>();
  constructor(private readonly publish: (frame: CodexRetryFrame) => void) {}

  accept(method: string, params: NativeParams, currentTurn?: string): void {
    if (!currentTurn || params.turnId !== currentTurn) return;
    if (method === "error" && params.willRetry === true) {
      const error = params.error ?? {};
      const message = typeof error.message === "string" ? error.message.slice(0, 2000) : undefined;
      const details = typeof error.additionalDetails === "string" ? error.additionalDetails.slice(0, 4000) : undefined;
      // Extract only the declared HTTP status, not arbitrary provider data.
      const info = error.codexErrorInfo;
      const variant = info && typeof info === "object" ? Object.values(info)[0] as NativeParams | undefined : undefined;
      const status = variant?.httpStatusCode;
      this.retryingTurn = currentTurn;
      this.publish({ type: "codex_retry", turn_id: currentTurn, status: "retrying",
        ...(message ? { message } : {}), ...(details && details !== message ? { details } : {}),
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatusCode: status } : {}),
      });
      return;
    }
    const item = params.item;
    if ((method === "item/started" || method === "item/completed") && typeof item?.id === "string") {
      const key = `${currentTurn}:${item.id}`;
      const fresh = !this.seenItems.has(key);
      this.seenItems.add(key);
      // An old partial item's completion, user echo or tool-output chunk is
      // not evidence that the model stream has recovered. A new model item is.
      if (fresh && MODEL_ITEMS.has(item.type)) this.resume(currentTurn);
    } else if (MODEL_DELTAS.has(method) && typeof params.delta === "string" && params.delta.length) {
      this.resume(currentTurn);
    }
  }

  private resume(turn: string): void {
    if (this.retryingTurn !== turn) return;
    this.retryingTurn = undefined;
    this.publish({ type: "codex_retry", turn_id: turn, status: "resumed" });
  }

  end(): void {
    if (!this.retryingTurn) return;
    const turn = this.retryingTurn;
    this.retryingTurn = undefined;
    this.publish({ type: "codex_retry", turn_id: turn, status: "ended" });
  }
}
