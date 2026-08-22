import assert from "node:assert/strict";

// Interface-only test: no CLI is spawned. It proves two things before any real
// executor exists —
//   1. both providers CAN implement the contract (compile-time, via the
//      `Executor` annotations on the two stubs below), and
//   2. every option the current SDK call sites pass is expressible in
//      `ExecOptions` (compile-time, via the two option literals).
// If a future change makes either untrue, `npm run typecheck` fails here.

type Executor = import("./types.ts").Executor;
type ExecFrame = import("./types.ts").ExecFrame;
type ExecOptions = import("./types.ts").ExecOptions;
type ExecResult = import("./types.ts").ExecResult;

// ── 1. Both providers implement the same contract ──────────────────────────

// Mirrors what a real Claude executor does: raw frames, then exactly one
// `ended`. Aborts report "aborted", never "failed".
const claudeStub: Executor = {
  id: "claude",
  async describe() {
    return { bin: "/usr/local/bin/claude", version: "2.1.239" };
  },
  async *exec(opts: ExecOptions): AsyncGenerator<ExecFrame, void, void> {
    if (opts.signal.aborted) {
      yield {
        kind: "ended",
        result: { status: "aborted", failureKind: "none" },
      };
      return;
    }
    // stream-json frame, verbatim — the shape processor.ts already folds.
    yield { kind: "raw", payload: { type: "system", subtype: "init" } };
    yield {
      kind: "ended",
      result: {
        status: "completed",
        failureKind: "none",
        sessionHandle: "sess-1",
      },
    };
  },
};

// Codex differs in every provider detail (thread id instead of session id,
// no permission ask on `codex exec`) yet satisfies the identical contract.
const codexStub: Executor = {
  id: "codex",
  async describe() {
    return { bin: "/usr/local/bin/codex", version: "0.144.1" };
  },
  async *exec(): AsyncGenerator<ExecFrame, void, void> {
    yield { kind: "raw", payload: { type: "thread.started" } };
    yield {
      kind: "ended",
      result: {
        status: "failed",
        failureKind: "transient",
        error: "no rollout found for thread id abc",
        sessionNotFound: true,
      },
    };
  },
};

async function drain(ex: Executor, opts: ExecOptions) {
  const frames: ExecFrame[] = [];
  for await (const f of ex.exec(opts)) frames.push(f);
  return frames;
}

const baseOpts = (signal: AbortSignal): ExecOptions => ({
  prompt: "hi",
  cwd: "/tmp",
  signal,
});

// ── 2. Every current call site's options are expressible ───────────────────

// Mirrors server/chat.ts:426-448 (the web solo Claude turn). `resume`,
// `permissionMode`, `effort`, `disallowedTools`, the systemPrompt append, and
// the canUseTool callback all have a home. In-process mcpServers become HTTP
// specs (decision #16).
const claudeCallSite: ExecOptions = {
  prompt: "refactor auth.ts",
  cwd: "/Users/me/proj",
  signal: new AbortController().signal,
  model: "sonnet",
  effort: "high",
  mode: "default",
  resume: "9f0c-…",
  images: [{ name: "a.png", mediaType: "image/png", data: "iVBOR" }],
  mcpServers: [
    { name: "bash", url: "http://127.0.0.1:8787/api/mcp/bash", bearerToken: "t" },
    { name: "schedule", url: "http://127.0.0.1:8787/api/mcp/schedule" },
    {
      name: "lark",
      url: "http://127.0.0.1:8787/api/mcp/lark",
      bearerToken: "t",
      autoAllow: true,
    },
  ],
  disallowedTools: ["Bash", "BashOutput", "KillBash", "ScheduleWakeup"],
  allowedTools: ["mcp__bash__run"],
  appendSystemPrompt: "extra rules",
  timeoutMs: 600_000,
  onPermissionAsk: async ({ input }) => ({
    behavior: "allow",
    updatedInput: input,
  }),
};

// Mirrors server/codex-chat.ts:373-380. sandboxMode + approvalPolicy are both
// derived from `mode` inside the executor; skipGitRepoCheck is always true so
// it is not an option.
const codexCallSite: ExecOptions = {
  prompt: "run the tests",
  cwd: "/Users/me/proj",
  signal: new AbortController().signal,
  model: "gpt-5.5",
  effort: "xhigh",
  mode: "acceptEdits",
  resume: "thread-abc",
};

// ── Runtime: the generator protocol holds ─────────────────────────────────

const ac = new AbortController();
const claudeFrames = await drain(claudeStub, baseOpts(ac.signal));
assert.equal(claudeFrames.at(-1)?.kind, "ended", "must end with an `ended` frame");
assert.equal(claudeFrames.filter((f) => f.kind === "ended").length, 1,
  "exactly one terminal frame");

const codexFrames = await drain(codexStub, baseOpts(ac.signal));
assert.equal(codexFrames.at(-1)?.kind, "ended");

// An already-aborted signal must still produce a terminal frame, and it must
// say "aborted" — a cancelled child also exits non-zero, so callers can never
// infer this from the exit code.
const aborted = new AbortController();
aborted.abort();
const abortedFrames = await drain(claudeStub, baseOpts(aborted.signal));
const last = abortedFrames.at(-1);
assert.equal(last?.kind, "ended");
assert.equal((last as { result: ExecResult }).result.status, "aborted");

// sessionNotFound is the one concrete case behind failureKind "transient" —
// callers self-heal by dropping the handle and replaying full history.
const codexEnd = codexFrames.at(-1) as { result: ExecResult };
assert.equal(codexEnd.result.sessionNotFound, true);
assert.equal(codexEnd.result.failureKind, "transient");

// Silence unused-value lint for the two compile-time-only literals.
assert.ok(claudeCallSite.prompt && codexCallSite.prompt);
assert.equal(claudeStub.id, "claude");
assert.equal(codexStub.id, "codex");

console.log("contract.test.ts: all assertions passed");
