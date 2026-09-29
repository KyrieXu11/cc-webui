import assert from "node:assert/strict";
import { isCodexIgnoredFeatureNotice, isCodexNonFatalNotice } from "../../shared/codex-notices.ts";
import { applySDKMessage, sessionMessagesToEvents } from "./processor.ts";

const message = "Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n" +
  "  user (/Users/example/.codex/config.toml): `features.child_agents_md` is ignored.\n" +
  "  user (/Users/example/.codex/config.toml): `features.goal` is ignored.";
const warning = { type: "item.completed", item: { id: "warning", type: "error", message } };
assert.ok(isCodexIgnoredFeatureNotice(warning));
for (const type of ["item.started", "item.updated", "item.completed"]) {
  assert.ok(isCodexNonFatalNotice({ ...warning, type }));
}
assert.deepEqual(applySDKMessage([], warning, () => {}), []);
const history = sessionMessagesToEvents([{ provider: "codex", prompt: "你好", startedAt: 1, events: [warning, { ...warning, item: { ...warning.item, id: "duplicate" } }, { type: "item.completed", item: { id: "answer", type: "agent_message", text: "你好！" } }] }]);
assert.deepEqual(history.map(e => "text" in e ? e.text : ""), ["你好", "你好！"]);
for (const unknown of [
  message.replace("features.goal", "approval_policy"),
  message.replace("features.goal", "features.sandbox"),
  message + "\nAuthentication failed",
  message.replace("ignoring 2", "ignoring 3"),
]) {
  const ev = { ...warning, item: { ...warning.item, message: unknown } };
  assert.equal(isCodexNonFatalNotice(ev), false, "unknown/sensitive warnings stay visible");
  assert.equal(applySDKMessage([], ev, () => {}).length, 1);
}
const failed = { type: "turn.failed", error: { message } };
assert.equal(isCodexNonFatalNotice(failed), false);
assert.equal(applySDKMessage([], failed, () => {}).length, 1, "fatal events must never be suppressed");
assert.equal(isCodexNonFatalNotice({ type: "error", message }), false);
assert.equal(isCodexNonFatalNotice(null), false);
