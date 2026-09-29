// Both live streams and historical replay use this narrow detector. Never hide
// turn.failed, top-level errors, or unknown configuration/security warnings.
function errorItemMessage(ev: unknown): string | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as { type?: unknown; item?: { type?: unknown; message?: unknown } };
  if (!["item.started", "item.updated", "item.completed"].includes(String(e.type))) return null;
  return e.item?.type === "error" && typeof e.item.message === "string" ? e.item.message : null;
}

export function isCodexModelMismatchNotice(ev: unknown): boolean {
  const message = errorItemMessage(ev);
  return message !== null && /recorded with model[\s\S]*resuming with/i.test(message);
}

export function isCodexIgnoredFeatureNotice(ev: unknown): boolean {
  const message = errorItemMessage(ev);
  if (message === null) return false;
  const lines = message.trim().split(/\r?\n/);
  const count = /^Codex is ignoring ([1-9]\d*) unrecognized configuration settings?\. Check for typos or deprecated settings\.$/.exec(lines[0]);
  return !!count && lines.length === Number(count[1]) + 1 && lines.slice(1).every(line =>
    /^\s*user \([^\r\n]+\): `features\.(?:child_agents_md|goal)` is ignored\.$/.test(line));
}

export function isCodexNonFatalNotice(ev: unknown): boolean {
  return isCodexModelMismatchNotice(ev) || isCodexIgnoredFeatureNotice(ev);
}
