import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-modelchange-test-${Date.now()}`);
process.env.CC_WEBUI_GROUPS_DIR = tmp;

const { isCodexModelMismatchNotice } = await import("../codex-events.ts");
const { clearSessionsForModelChanges } = await import("./lifecycle.ts");
const { setAgentSessionId, getAgentSessionId } = await import("./runtime.ts");
const { newGroupId, ensureGroupDir } = await import("./store.ts");
const { defaultParticipant } = await import("./config.ts");
type Participant = import("./config.ts").Participant;

await fs.mkdir(tmp, { recursive: true });

try {
  // ── isCodexModelMismatchNotice ────────────────────────────────────────────

  // The real advisory the Codex CLI emits, as an `error` thread item.
  const mismatchMsg =
    "This session was recorded with model `gpt-5.3-codex` but is resuming " +
    "with `gpt-5.5`. Consider switching back to `gpt-5.3-codex` with /model.";

  for (const type of ["item.started", "item.updated", "item.completed"]) {
    assert.equal(
      isCodexModelMismatchNotice({
        type,
        item: { id: "e1", type: "error", message: mismatchMsg },
      }),
      true,
      `${type} carrying the mismatch advisory should match`,
    );
  }

  // A genuine (non-mismatch) error item must NOT be suppressed.
  assert.equal(
    isCodexModelMismatchNotice({
      type: "item.completed",
      item: { id: "e2", type: "error", message: "sandbox denied write" },
    }),
    false,
    "unrelated error items must still surface",
  );

  // Non-error items, wrong event types, and junk are ignored.
  assert.equal(
    isCodexModelMismatchNotice({
      type: "item.completed",
      item: { id: "a1", type: "agent_message", text: mismatchMsg },
    }),
    false,
    "agent_message must not be treated as a notice even if text matches",
  );
  assert.equal(
    isCodexModelMismatchNotice({ type: "turn.completed", usage: {} }),
    false,
  );
  assert.equal(isCodexModelMismatchNotice(null), false);
  assert.equal(isCodexModelMismatchNotice("nope"), false);
  assert.equal(
    isCodexModelMismatchNotice({ type: "item.completed" }),
    false,
    "missing item is not a notice",
  );

  // ── clearSessionsForModelChanges ──────────────────────────────────────────

  // Only the participant whose model changed gets its session cleared.
  {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    await setAgentSessionId(gid, "claude", "claude-sess-1");
    await setAgentSessionId(gid, "codex", "codex-thread-1");

    const before = [defaultParticipant("claude"), defaultParticipant("codex")];
    const after = [
      { ...defaultParticipant("claude") }, // model unchanged
      { ...defaultParticipant("codex"), model: "gpt-5.4" }, // model changed
    ];
    await clearSessionsForModelChanges(gid, before, after);

    assert.equal(
      await getAgentSessionId(gid, "claude"),
      "claude-sess-1",
      "unchanged model keeps its resumed session",
    );
    assert.equal(
      await getAgentSessionId(gid, "codex"),
      undefined,
      "changed model clears its resumed session",
    );
  }

  // No model change → nothing cleared (mode/effort edits must not reset cache).
  {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    await setAgentSessionId(gid, "codex", "codex-thread-2");

    const before = [defaultParticipant("codex")];
    const after: Participant[] = [
      { ...defaultParticipant("codex"), effort: "low", mode: "plan" },
    ];
    await clearSessionsForModelChanges(gid, before, after);

    assert.equal(
      await getAgentSessionId(gid, "codex"),
      "codex-thread-2",
      "mode/effort-only change must keep the resumed session",
    );
  }

  console.log("model-change.test.ts: all assertions passed");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
