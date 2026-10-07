import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  resolveCodexBin,
  CODEX_JSON_FLAG,
  mapSandbox,
  mapEffort,
  mcpTokenEnvVar,
  mcpConfigOverrides,
  buildConfigOverrides,
  buildCodexArgs,
  spillImages,
  CodexImageError,
  threadIdFrom,
  turnOutcomeFrom,
  errorMessageFrom,
  isThreadNotFound,
  classifyCodexError,
  classifyCodexTermination,
} = await import("./codex-executor.ts");

type ExecOptions = import("./types.ts").ExecOptions;

const savedBin = process.env.CC_WEBUI_CODEX_BIN;
const base = (over: Partial<ExecOptions> = {}): ExecOptions => ({
  prompt: "hi",
  cwd: "/tmp/proj",
  signal: new AbortController().signal,
  ...over,
});

try {
  // ── binary resolution (decision #11) ──────────────────────────────────────

  delete process.env.CC_WEBUI_CODEX_BIN;
  assert.equal(resolveCodexBin(), "codex", "unset → resolve from PATH");
  process.env.CC_WEBUI_CODEX_BIN = "   ";
  assert.equal(resolveCodexBin(), "codex", "blank → resolve from PATH");
  process.env.CC_WEBUI_CODEX_BIN = "/opt/codex";
  assert.equal(resolveCodexBin(), "/opt/codex", "set → pin that binary");

  // ── mode → sandbox ────────────────────────────────────────────────────────

  assert.equal(mapSandbox("plan"), "read-only");
  assert.equal(mapSandbox("bypassPermissions"), "danger-full-access");
  assert.equal(mapSandbox("default"), "workspace-write");
  assert.equal(mapSandbox("acceptEdits"), "workspace-write");
  assert.equal(mapSandbox(undefined), "workspace-write");

  assert.equal(mapEffort("low"), "low");
  assert.equal(mapEffort("xhigh"), "xhigh");
  assert.equal(mapEffort("max"), "max");
  assert.equal(mapEffort("ultra"), "ultra");
  assert.equal(mapEffort(undefined), "medium");
  assert.equal(mapEffort("bogus"), "medium");

  // ── `-c` overrides ────────────────────────────────────────────────────────

  assert.equal(mcpTokenEnvVar("bash"), "CC_WEBUI_MCP_TOKEN_BASH");
  assert.equal(
    mcpTokenEnvVar("local-playwright"),
    "CC_WEBUI_MCP_TOKEN_LOCAL_PLAYWRIGHT",
    "server names are slugged, so a dashed name still yields a legal env var",
  );

  const mcp = mcpConfigOverrides([
    { name: "bash", url: "http://127.0.0.1:8787/api/mcp/bash", bearerToken: "t0" },
    { name: "schedule", url: "http://127.0.0.1:8787/api/mcp/schedule" },
  ]);
  assert.ok(
    mcp.includes('mcp_servers.bash.url="http://127.0.0.1:8787/api/mcp/bash"'),
    "url is rendered as a quoted TOML string",
  );
  // ⚠️ The token itself must never appear in argv — `ps` is world-readable and
  // an MCP token is equivalent to a shell (AGENTS.md 安全边界).
  assert.ok(
    mcp.includes('mcp_servers.bash.bearer_token_env_var="CC_WEBUI_MCP_TOKEN_BASH"'),
    "argv carries the env var NAME, not the token",
  );
  assert.ok(
    !mcp.some((o) => o.includes("t0")),
    "no override may contain the bearer token value",
  );
  assert.ok(
    !mcp.some((o) => o.startsWith("mcp_servers.schedule.bearer_token_env_var")),
    "a server without a token declares no env var",
  );
  assert.ok(
    mcp.includes('mcp_servers.schedule.default_tools_approval_mode="approve"'),
    "every server gets approve: with approval_policy=never a non-approve " +
      "default rejects the call instead of prompting",
  );

  const overrides = buildConfigOverrides(base({ effort: "high" }));
  assert.ok(overrides.includes('approval_policy="never"'));
  assert.ok(overrides.includes('model_reasoning_effort="high"'));

  // ── argv ──────────────────────────────────────────────────────────────────

  const fresh = buildCodexArgs(base({ model: "gpt-5.5", mode: "plan" }));
  assert.equal(fresh[0], "exec");
  assert.equal(fresh[1], CODEX_JSON_FLAG);
  assert.equal(CODEX_JSON_FLAG, "--experimental-json", "decision #14, not --json");
  assert.deepEqual(
    [fresh[fresh.indexOf("--model") + 1], fresh[fresh.indexOf("--sandbox") + 1]],
    ["gpt-5.5", "read-only"],
  );
  assert.equal(fresh[fresh.indexOf("--cd") + 1], "/tmp/proj");
  assert.ok(fresh.includes("--skip-git-repo-check"));
  assert.ok(!fresh.includes("resume"));
  // The prompt travels on stdin and must never become a positional argument.
  assert.ok(!fresh.includes("hi"), "prompt is not in argv");

  // Omitting --model lets ~/.codex/config.toml's own `model` win, which is the
  // behavior the SDK had.
  assert.ok(!buildCodexArgs(base()).includes("--model"));

  // ⚠️ `resume` is a subcommand: every option must precede it, or clap hands it
  // to the subcommand instead.
  const resumed = buildCodexArgs(base({ resume: "01a0-thread", model: "gpt-5.5" }));
  const rIdx = resumed.indexOf("resume");
  assert.ok(rIdx > 0);
  assert.equal(resumed[rIdx + 1], "01a0-thread");
  for (const flag of ["--config", "--model", "--sandbox", "--cd", "--skip-git-repo-check"]) {
    assert.ok(
      resumed.indexOf(flag) < rIdx,
      `${flag} must come before the resume subcommand`,
    );
  }

  // ⚠️ `--image <FILE>...` is variadic — the same argument-eating shape that
  // broke buildClaudeArgs. Nothing positional may ever follow it.
  const withImgs = buildCodexArgs(base({ resume: "t1" }), ["/tmp/a.png", "/tmp/b.png"]);
  const firstImg = withImgs.indexOf("--image");
  assert.ok(firstImg > withImgs.indexOf("resume"), "images bind to the resume subcommand");
  const tail = withImgs.slice(firstImg);
  for (let i = 0; i < tail.length; i += 2) {
    assert.equal(tail[i], "--image", "after the first --image, only --image pairs");
  }
  assert.equal(withImgs.at(-1), "/tmp/b.png");

  // ── images ────────────────────────────────────────────────────────────────

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-exec-test-"));
  try {
    const png = Buffer.from("fake").toString("base64");
    const paths = await spillImages(
      [
        { name: "a.png", mediaType: "image/png", data: png },
        // Not an image at all → skipped, as both former call sites did.
        { name: "n.txt", mediaType: "text/plain", data: png },
      ],
      dir,
    );
    assert.equal(paths.length, 1);
    assert.ok(paths[0].endsWith(".png"));
    assert.equal((await fs.readFile(paths[0])).toString(), "fake");

    // An image Codex cannot take is a hard failure, never a silent drop: the
    // model would otherwise answer about a picture it never received.
    await assert.rejects(
      () => spillImages([{ mediaType: "image/tiff", data: png }], dir),
      CodexImageError,
    );
    await assert.rejects(
      () =>
        spillImages(
          [{ mediaType: "image/png", data: "A".repeat(20 * 1024 * 1024) }],
          dir,
        ),
      CodexImageError,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ── frame classification (payloads captured from codex-cli 0.144.1) ───────

  assert.equal(
    threadIdFrom({ type: "thread.started", thread_id: "01a0ad4e-5170" }),
    "01a0ad4e-5170",
  );
  assert.equal(threadIdFrom({ type: "turn.started" }), undefined);

  assert.deepEqual(
    turnOutcomeFrom({
      type: "turn.completed",
      usage: { input_tokens: 9877, output_tokens: 6 },
    }),
    { kind: "completed" },
  );
  assert.deepEqual(
    turnOutcomeFrom({ type: "turn.failed", error: { message: "boom" } }),
    { kind: "failed", error: "boom" },
  );
  assert.equal(turnOutcomeFrom({ type: "item.completed", item: {} }), null);

  // Real payload: a model the account may not use.
  const rejected =
    '{"type":"error","status":400,"error":{"type":"invalid_request_error",' +
    '"message":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}}';
  assert.equal(errorMessageFrom({ type: "error", message: rejected }), rejected);
  assert.equal(errorMessageFrom({ type: "turn.started" }), undefined);

  // ── stale thread ──────────────────────────────────────────────────────────

  const staleMsg =
    "thread/resume: thread/resume failed: no rollout found for thread id " +
    "00000000-0000-0000-0000-000000000000 (code -32600)";
  assert.equal(isThreadNotFound(staleMsg), true);
  assert.equal(isThreadNotFound("something else"), false);
  assert.equal(classifyCodexError(staleMsg), "transient");
  assert.equal(classifyCodexError(rejected), "permanent", "400 → don't retry");
  assert.equal(classifyCodexError("stream error: 503 upstream"), "transient");

  // ── termination ───────────────────────────────────────────────────────────

  const term = (over: Partial<Parameters<typeof classifyCodexTermination>[0]>) =>
    classifyCodexTermination({
      aborted: false,
      timedOut: false,
      exitCode: 0,
      outcome: null,
      stderrTail: "",
      ...over,
    });

  assert.equal(term({ outcome: { kind: "completed" } }).status, "completed");

  // ⚠️ A cancelled child also exits non-zero — the cause must beat the code.
  assert.equal(term({ aborted: true, exitCode: 1 }).status, "aborted");
  assert.equal(term({ aborted: true, exitCode: 1 }).failureKind, "none");
  assert.equal(term({ timedOut: true, exitCode: 1 }).status, "timeout");
  // Abort wins over an error frame that arrived as the process was torn down.
  assert.equal(
    term({ aborted: true, exitCode: 1, lastError: "stream closed" }).status,
    "aborted",
  );

  // The stale-resume path: exit 1, NOT ONE json frame, reason only on stderr.
  const stale = term({ exitCode: 1, stderrTail: `Error: ${staleMsg}` });
  assert.equal(stale.status, "failed");
  assert.equal(stale.sessionNotFound, true);
  assert.equal(stale.failureKind, "transient");

  const failed = term({
    exitCode: 1,
    outcome: { kind: "failed", error: rejected },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureKind, "permanent");
  assert.equal(failed.sessionNotFound, false);

  assert.equal(
    term({ spawnError: "spawn codex ENOENT" }).error,
    "spawn codex ENOENT",
  );

  console.log("codex-executor.test.ts: all assertions passed");
} finally {
  if (savedBin === undefined) delete process.env.CC_WEBUI_CODEX_BIN;
  else process.env.CC_WEBUI_CODEX_BIN = savedBin;
}
