// Translate app-server notifications into the existing exec-shaped UI frames.
// Keep native turn/item IDs: a steer adds a user boundary, NOT a new tool ID.
type Item = Record<string, any>;

export function normalizeAppItem(item: Item): Item | null {
  if (typeof item?.id !== "string") return null;
  if (item.status === "declined") item = { ...item, status: "failed" };
  switch (item.type) {
    case "agentMessage": return { ...item, type: "agent_message" };
    case "reasoning": return { id: item.id, type: "reasoning", summary: item.summary ?? [], text: (item.summary ?? []).join("\n\n") };
    case "commandExecution": return { ...item, type: "command_execution", aggregated_output: item.aggregatedOutput ?? "", exit_code: item.exitCode };
    case "fileChange": return { ...item, type: "file_change", changes: (item.changes ?? []).map((c: Item) => ({ ...c, kind: c.kind?.type ?? c.kind, move_path: c.kind?.move_path })) };
    case "mcpToolCall": return { ...item, type: "mcp_tool_call" };
    case "webSearch": return { ...item, type: "web_search" };
    case "imageView": return { ...item, type: "image_view" };
    case "collabAgentToolCall": return { ...item, type: "collab_agent_tool_call", sender_thread_id: item.senderThreadId, receiver_thread_ids: item.receiverThreadIds, agents_states: item.agentsStates };
    case "contextCompaction": return { ...item, type: "context_compaction" };
    // User input is published on accepted steer by the route, not duplicated
    // by both item/started and item/completed (initial input already echoed).
    case "userMessage": return null;
    default: return null;
  }
}

export class CodexAppEvents {
  private items = new Map<string, Item>();
  constructor(private readonly publish: (frame: Item) => void) {}

  accept(method: string, params: Item): void {
    const turnId = params.turnId;
    const emit = (type: string, item: Item) => this.publish({ type, item, turn_id: turnId });
    if (method === "item/started" || method === "item/completed") {
      const item = normalizeAppItem(params.item);
      if (!item) return;
      const key = `${turnId}:${item.id}`;
      // Final messages win over accumulated deltas; empty final tool output
      // must not erase output we actually received on the delta channel.
      const previous = this.items.get(key);
      if (previous?.type === "command_execution" && !item.aggregated_output) item.aggregated_output = previous.aggregated_output;
      this.items.set(key, item);
      emit(method === "item/started" ? "item.started" : "item.completed", item);
      return;
    }
    if (typeof params.itemId !== "string") return;
    const key = `${turnId}:${params.itemId}`;
    let item = this.items.get(key);
    if (method === "item/agentMessage/delta") {
      item ??= { id: params.itemId, type: "agent_message", text: "" };
      item = { ...item, text: (item.text ?? "") + (params.delta ?? "") };
      this.items.set(key, item);
      this.publish({ type: "codex_delta", turn_id: turnId, item_id: item.id, item_type: "agent_message", delta: params.delta ?? "" });
      return;
    } else if (method === "item/reasoning/summaryTextDelta") {
      item ??= { id: params.itemId, type: "reasoning", summary: [], text: "" };
      const summary = [...(item.summary ?? [])];
      const index = Number.isSafeInteger(params.summaryIndex) ? params.summaryIndex : 0;
      if (index < 0 || index > 1000) return;
      summary[index] = (summary[index] ?? "") + (params.delta ?? "");
      item = { ...item, summary, text: summary.join("\n\n") };
    } else if (method === "item/commandExecution/outputDelta" && item) {
      item = { ...item, aggregated_output: (item.aggregated_output ?? "") + (params.delta ?? "") };
      this.items.set(key, item);
      this.publish({ type: "codex_delta", turn_id: turnId, item_id: item.id, item_type: "command_execution", delta: params.delta ?? "" });
      return;
    } else return;
    this.items.set(key, item);
    emit("item.updated", item);
  }
}
