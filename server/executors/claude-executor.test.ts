import assert from "node:assert/strict";

const {
  resolveClaudeBin,
  needsStdinProtocol,
  buildMcpConfig,
  buildClaudeArgs,
  buildPromptMessage,
  claudeApiErrorFrom,
  classifyApiError,
  apiFailureMessage,
  isSessionNotFound,
  sessionIdFrom,
  resultSummaryFrom,
  classifyTermination,
} = await import("./claude-executor.ts");

type ExecOptions = import("./types.ts").ExecOptions;

const savedBin = process.env.CC_WEBUI_CLAUDE_BIN;
const base = (over: Partial<ExecOptions> = {}): ExecOptions => ({
  prompt: "hi",
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...over,
});

try {
  // ── binary resolution (decision #11) ──────────────────────────────────────

  delete process.env.CC_WEBUI_CLAUDE_BIN;
  assert.equal(resolveClaudeBin(), "claude", "unset → resolve from PATH");
  process.env.CC_WEBUI_CLAUDE_BIN = "   ";
  assert.equal(resolveClaudeBin(), "claude", "blank → resolve from PATH");
  process.env.CC_WEBUI_CLAUDE_BIN = "/opt/claude";
  assert.equal(resolveClaudeBin(), "/opt/claude", "set → pin that binary");

  // ── argv ──────────────────────────────────────────────────────────────────

  // No permission handler and no images → prompt is positional, no stdin proto.
  const plain = buildClaudeArgs(base({ prompt: "say hi" }));
  assert.equal(needsStdinProtocol(base()), false);
  assert.ok(!plain.includes("--input-format"));
  assert.ok(!plain.includes("--permission-prompt-tool"));
  assert.equal(plain.at(-1), "say hi", "prompt must be the last positional");

  // Either a permission handler OR images forces the stdin protocol.
  const withPerm = base({
    onPermissionAsk: async ({ input }) => ({
      behavior: "allow",
      updatedInput: input,
    }),
  });
  assert.equal(needsStdinProtocol(withPerm), true);
  const permArgs = buildClaudeArgs(withPerm);
  assert.ok(permArgs.includes("--input-format"));
  // `stdio` is a sentinel value, not a tool name.
  const ppIdx = permArgs.indexOf("--permission-prompt-tool");
  assert.ok(ppIdx >= 0);
  assert.equal(permArgs[ppIdx + 1], "stdio");
  assert.ok(
    !permArgs.includes("hi"),
    "prompt must NOT be positional once it goes over stdin",
  );

  const withImg = base({
    images: [{ mediaType: "image/png", data: "iVBOR" }],
  });
  assert.equal(needsStdinProtocol(withImg), true, "images also force stdin");

  // Every option lands on the right flag.
  const full = buildClaudeArgs(
    base({
      mode: "default",
      model: "sonnet",
      effort: "high",
      resume: "sess-9",
      appendSystemPrompt: "extra",
      allowedTools: ["mcp__bash__run", "Read"],
      disallowedTools: ["Bash", "KillBash"],
      mcpServers: [
        { name: "bash", url: "http://127.0.0.1:8787/api/mcp/bash", bearerToken: "tok" },
      ],
    }),
  );
  const pairOf = (flag: string) => full[full.indexOf(flag) + 1];
  assert.equal(pairOf("--permission-mode"), "default");
  assert.equal(pairOf("--model"), "sonnet");
  assert.equal(pairOf("--effort"), "high");
  assert.equal(pairOf("--resume"), "sess-9");
  assert.equal(pairOf("--append-system-prompt"), "extra");
  assert.equal(pairOf("--allowedTools"), "mcp__bash__run,Read");
  assert.equal(pairOf("--disallowedTools"), "Bash,KillBash");
  assert.ok(
    full.includes("--strict-mcp-config"),
    "MCP config must be strict — otherwise the user's own ~/.claude servers load too",
  );
  assert.ok(full.includes("--include-partial-messages"));
  assert.ok(full.includes("--verbose"));

  // MCP config is inline JSON (--mcp-config takes files OR strings).
  const cfg = JSON.parse(
    buildMcpConfig([
      { name: "bash", url: "http://h/bash", bearerToken: "tok" },
      { name: "schedule", url: "http://h/sched" },
    ]),
  );
  assert.deepEqual(cfg.mcpServers.bash, {
    type: "http",
    url: "http://h/bash",
    headers: { authorization: "Bearer tok" },
  });
  assert.deepEqual(cfg.mcpServers.schedule, {
    type: "http",
    url: "http://h/sched",
  });

  // ── prompt message over stdin ─────────────────────────────────────────────

  const msg = JSON.parse(
    buildPromptMessage(
      base({
        prompt: "look",
        images: [{ mediaType: "image/png", data: "AAA" }],
      }),
    ),
  );
  assert.equal(msg.type, "user");
  assert.equal(msg.message.role, "user");
  assert.deepEqual(msg.message.content[0], { type: "text", text: "look" });
  assert.deepEqual(msg.message.content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAA" },
  });
  // Empty prompt + image only → no empty text block.
  const imgOnly = JSON.parse(
    buildPromptMessage(base({ prompt: "  ", images: [{ mediaType: "image/png", data: "A" }] })),
  );
  assert.equal(imgOnly.message.content.length, 1);

  // ── synthetic "API Error" assistant message (the lvshu trap) ──────────────

  const realAnswer = {
    type: "assistant",
    message: { model: "claude-sonnet-5", content: [{ type: "text", text: "hello" }] },
  };
  assert.equal(claudeApiErrorFrom(realAnswer), null, "a real answer is not an error");

  // Primary criterion: the CLI's own flag.
  const flagged = {
    type: "assistant",
    is_api_error_message: true,
    api_error_status: 529,
    message: {
      model: "<synthetic>",
      error: "server_error",
      content: [{ type: "text", text: "API Error: Overloaded" }],
    },
  };
  const f1 = claudeApiErrorFrom(flagged);
  assert.ok(f1, "is_api_error_message must be detected");
  assert.equal(f1!.status, 529);
  assert.equal(f1!.kind, "server_error");
  assert.equal(classifyApiError(f1!), "transient", "529 is worth retrying");

  // Fallback criterion: <synthetic> model + error-shaped text, no flag.
  const unflagged = {
    type: "assistant",
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: Unable to connect to API (ECONNRESET)" }],
    },
  };
  const f2 = claudeApiErrorFrom(unflagged);
  assert.ok(f2, "fallback must catch a drifted flag name");
  assert.equal(classifyApiError(f2!), "transient");

  // A <synthetic> message whose text is NOT error-shaped must pass through —
  // degrading to "treat as content" is the safe direction.
  assert.equal(
    claudeApiErrorFrom({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Continuing." }] },
    }),
    null,
  );

  // 401 auth failure is permanent — retrying would just burn quota.
  assert.equal(
    classifyApiError({ text: "", kind: "authentication_failed", status: 401 }),
    "permanent",
  );
  assert.equal(classifyApiError({ text: "socket hang up", kind: "", status: 0 }), "transient");
  assert.equal(classifyApiError({ text: "invalid api key", kind: "", status: 0 }), "permanent");
  assert.equal(apiFailureMessage({ text: "boom", kind: "x", status: 0 }), "boom");
  assert.equal(apiFailureMessage({ text: "", kind: "server_error", status: 0 }),
    "model call failed: server_error");

  // ── result event ──────────────────────────────────────────────────────────

  assert.equal(sessionIdFrom({ session_id: "abc" }), "abc");
  assert.equal(sessionIdFrom({ session_id: "" }), undefined);
  assert.equal(sessionIdFrom("nope"), undefined);

  // ⚠️ the trap: terminal_reason api_error while subtype stays "success".
  const trap = resultSummaryFrom({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "api_error",
  });
  assert.ok(trap);
  assert.equal(trap!.isError, true, "api_error must count as an error despite subtype=success");
  const ok = resultSummaryFrom({ type: "result", subtype: "success", is_error: false });
  assert.equal(ok!.isError, false);
  // A non-"success" subtype is a failure even without is_error — the SDK-era
  // group runner needed this or a stale resume reported ok with no content.
  const maxTurns = resultSummaryFrom({
    type: "result",
    subtype: "error_max_turns",
    is_error: false,
  });
  assert.equal(maxTurns!.isError, true);
  assert.equal(maxTurns!.error, "error_max_turns", "subtype is the last-resort reason");
  assert.equal(resultSummaryFrom({ type: "assistant" }), null);

  // The reason lives in `errors` (an ARRAY), not `error`. This is the payload
  // captured verbatim from CLI 2.1.239 for a stale --resume; reading only the
  // singular field silently downgraded a self-healable case to permanent.
  const staleResult = resultSummaryFrom({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: "00000000-0000-4000-8000-000000000000",
    errors: [
      "No conversation found with session ID: 00000000-0000-4000-8000-000000000000",
    ],
  });
  assert.ok(staleResult);
  assert.match(staleResult!.error!, /No conversation found/);
  assert.equal(isSessionNotFound(staleResult!.error), true);
  // Singular `error` still works, and multiple entries are joined.
  assert.equal(
    resultSummaryFrom({ type: "result", is_error: true, error: "boom" })!.error,
    "boom",
  );
  assert.equal(
    resultSummaryFrom({ type: "result", is_error: true, errors: ["a", "b"] })!.error,
    "a; b",
  );

  // End to end through the classifier: the real payload must self-heal.
  const staleEndToEnd = classifyTermination({
    aborted: false,
    timedOut: false,
    exitCode: 1,
    result: staleResult,
    apiFailure: null,
    stderrTail: "",
  });
  assert.equal(staleEndToEnd.sessionNotFound, true);
  assert.equal(staleEndToEnd.failureKind, "transient");

  // stderr is the fallback source if `errors` is ever renamed away.
  const staleViaStderr = classifyTermination({
    aborted: false,
    timedOut: false,
    exitCode: 1,
    result: { isError: true, subtype: "error_during_execution" },
    apiFailure: null,
    stderrTail: "No conversation found with session ID: zzz",
  });
  assert.equal(staleViaStderr.sessionNotFound, true);
  assert.equal(staleViaStderr.failureKind, "transient");

  // ── stale resumed session ─────────────────────────────────────────────────

  assert.equal(isSessionNotFound("No conversation found with session ID abc"), true);
  assert.equal(isSessionNotFound("no conversation found with session id abc"), true);
  assert.equal(isSessionNotFound("something else"), false);
  assert.equal(isSessionNotFound(undefined), false);

  // ── termination precedence ────────────────────────────────────────────────

  const term = (over: Partial<Parameters<typeof classifyTermination>[0]>) =>
    classifyTermination({
      aborted: false,
      timedOut: false,
      exitCode: 0,
      result: null,
      apiFailure: null,
      stderrTail: "",
      ...over,
    });

  // A killed child also exits non-zero — these must not read as "failed".
  assert.equal(term({ timedOut: true, exitCode: 1 }).status, "timeout");
  assert.equal(term({ aborted: true, exitCode: 1 }).status, "aborted");
  assert.equal(term({ aborted: true, exitCode: 1 }).failureKind, "none");
  // Timeout outranks abort (we killed it for the timeout).
  assert.equal(term({ aborted: true, timedOut: true }).status, "timeout");

  assert.equal(term({ spawnError: "ENOENT" }).status, "failed");
  assert.equal(term({ spawnError: "ENOENT" }).failureKind, "permanent");

  // The synthetic API error beats a result event that claims success.
  const apiBeatsResult = term({
    exitCode: 1,
    result: { isError: false, subtype: "success" },
    apiFailure: { text: "API Error: Overloaded", kind: "server_error", status: 529 },
  });
  assert.equal(apiBeatsResult.status, "failed");
  assert.equal(apiBeatsResult.failureKind, "transient");

  // A successful result beats a non-zero exit code.
  assert.equal(
    term({ exitCode: 1, result: { isError: false, subtype: "success" } }).status,
    "completed",
  );

  // Stale session → transient + the self-heal flag.
  const stale = term({
    exitCode: 1,
    result: {
      isError: true,
      subtype: "error",
      error: "No conversation found with session ID zzz",
    },
  });
  assert.equal(stale.status, "failed");
  assert.equal(stale.failureKind, "transient");
  assert.equal(stale.sessionNotFound, true);

  // No result event at all → fall back to stderr tail.
  const noResult = term({ exitCode: 127, stderrTail: "claude: command not found" });
  assert.equal(noResult.status, "failed");
  assert.match(noResult.error!, /command not found/);

  // A dead handle must never be returned for the caller to re-persist.
  // (Behavioural note: enforced at the yield site in exec(), verified live.)
  assert.equal(staleEndToEnd.sessionNotFound, true);

  console.log("claude-executor.test.ts: all assertions passed");
} finally {
  if (savedBin === undefined) delete process.env.CC_WEBUI_CLAUDE_BIN;
  else process.env.CC_WEBUI_CLAUDE_BIN = savedBin;
}
