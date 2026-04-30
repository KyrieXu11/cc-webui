import assert from "node:assert/strict";
import {
  detachForegroundToBackground,
  listBackgroundTasks,
  listForegroundInvocations,
  relabelTasksSessionId,
  runBashTool,
  subscribeForegroundEvents,
} from "./bash-mcp.ts";

// Helper: small delay for spawn() to register handlers before we relabel.
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 1) Foreground started under a placeholder sessionId, then the codex thread
// migrates to its real id mid-flight. Detaching should attach the new
// BackgroundTask under the canonical (real) id, and the emitted
// foreground_ended event should carry the real id, not the placeholder.

const placeholder = "codex-turn-PLACEHOLDER";
const real = "thread-REAL-12345";

const events: Array<{ event: string; payload: any }> = [];
const unsub = subscribeForegroundEvents((event, data) => {
  events.push({ event, payload: JSON.parse(data) });
});

// Long-running foreground command. We don't await it — we'll detach mid-flight.
const fgPromise = runBashTool(
  { command: "sleep 30", run_in_background: false, timeout: 60_000 },
  { cwd: process.cwd(), getSessionId: () => placeholder }
);

// Give spawn() and foregroundInvocations.set() a tick to register.
await wait(50);

const [inv] = listForegroundInvocations({ sessionId: placeholder });
assert.ok(inv, "foreground invocation should be registered under placeholder");
assert.equal(inv.sessionId, placeholder);

// Simulate a Codex thread.started arriving mid-flight.
relabelTasksSessionId(placeholder, real);

// Detach now — the task and the emitted event must both use the real id.
const detach = detachForegroundToBackground(inv.fgId);
assert.equal(detach.ok, true);
const bashTaskId = (detach as { ok: true; bashTaskId: string }).bashTaskId;

// The promise resolves now that detach() called resolve() on it.
const result = (await fgPromise) as { content: Array<{ text: string }> };
assert.ok(result.content[0]?.text.includes(`bashTaskId: ${bashTaskId}`));

// New BackgroundTask should be tagged with the real (canonical) sessionId so
// `listBackgroundTasks({ sessionId: real })` includes it.
const tasksUnderReal = listBackgroundTasks({ sessionId: real }).map((t) => t.id);
assert.ok(
  tasksUnderReal.includes(bashTaskId),
  `expected ${bashTaskId} to appear under real sessionId, got ${JSON.stringify(tasksUnderReal)}`
);

// And the foreground_ended event should carry the real sessionId, not the
// stale placeholder. Also a foreground_started for the placeholder is fine —
// we only care about the ended payload.
const ended = events.find(
  (e) => e.event === "foreground_ended" && e.payload?.fgId === inv.fgId
);
assert.ok(ended, "expected a foreground_ended event for fgId");
assert.equal(
  ended!.payload.sessionId,
  real,
  `foreground_ended payload should be tagged with the real sessionId (got ${ended!.payload.sessionId})`
);
assert.equal(ended!.payload.bashTaskId, bashTaskId);

// Cleanup the now-running detached background task.
const tasks = listBackgroundTasks({ sessionId: real });
for (const t of tasks) {
  try {
    t.proc.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

unsub();
