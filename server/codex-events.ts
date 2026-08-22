// Shared helpers for interpreting Codex SDK ThreadEvents.

// The Codex CLI emits a non-fatal advisory when a thread is resumed under a
// different model than it was recorded with:
//
//   "This session was recorded with model `gpt-5.3-codex` but is resuming
//    with `gpt-5.5`. Consider switching back to `gpt-5.3-codex` ..."
//
// It arrives as an `error` thread item (SDK's non-fatal ErrorItem), NOT a
// fatal turn.failed — the turn still completes under the requested model. But
// because it's an `error` item it would otherwise leak into chat content:
// rendered as "❌ …" in the Feishu card (bridge.ts) and persisted as a
// "[错误] …" assistant message in the transcript (processor.ts). It's pure
// noise, so callers drop it from the event stream.
//
// The underlying cause (a stale resumed session recorded under an old model)
// is prevented going forward by clearing the persisted session id whenever a
// participant's model changes — see clearSessionsForModelChanges in
// groups/lifecycle.ts. This detector handles threads already in the mismatched
// state (e.g. created before a default-model change).
export function isCodexModelMismatchNotice(ev: unknown): boolean {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as { type?: unknown; item?: unknown };
  if (
    e.type !== "item.started" &&
    e.type !== "item.updated" &&
    e.type !== "item.completed"
  ) {
    return false;
  }
  const item = e.item as { type?: unknown; message?: unknown } | undefined;
  return (
    !!item &&
    item.type === "error" &&
    typeof item.message === "string" &&
    /recorded with model[\s\S]*resuming with/i.test(item.message)
  );
}
