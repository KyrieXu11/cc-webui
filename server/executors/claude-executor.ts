// Claude CLI executor — drives `claude` as a subprocess, no SDK.
//
// Replaces `query()` from @anthropic-ai/claude-agent-sdk. That SDK was itself a
// subprocess wrapper around a version-pinned bundled `claude`; this drives the
// binary the machine actually has. See docs/cli-migration.md for the verified
// facts behind every flag and wire format here.
//
// Reference implementation: lvshu's Go executor
// (~/code/ts/lvshu/server/internal/agent/claude.go + claude_apierror.go).
// Anything below marked "lvshu" is a lesson that repo paid for in production.

import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { PermissionUpdate } from "./permission-types.ts";
import type {
  ExecFrame,
  ExecOptions,
  ExecResult,
  Executor,
  FailureKind,
  McpServerSpec,
  PermissionAnswer,
  RunStatus,
} from "./types.ts";

// ─── Binary resolution ──────────────────────────────────────────────────────

// Empty/unset env var → resolve `claude` from PATH, i.e. follow whatever the
// machine has installed. Setting the var pins a specific binary, which is the
// escape hatch when a CLI auto-update breaks the undocumented control protocol.
export function resolveClaudeBin(): string {
  const raw = process.env.CC_WEBUI_CLAUDE_BIN?.trim();
  return raw || "claude";
}

// ─── argv ───────────────────────────────────────────────────────────────────

// `--input-format stream-json` is required for two independent reasons, so the
// prompt moves from a positional arg onto stdin whenever either applies:
//   - the control protocol answers `can_use_tool` by writing to stdin
//   - base64 images can only be expressed as prompt content blocks
export function needsStdinProtocol(opts: ExecOptions): boolean {
  return !!opts.onPermissionAsk || (opts.images?.length ?? 0) > 0;
}

// `--mcp-config` takes JSON files OR inline strings (`claude --help`), so no
// temp file is needed. HTTP transport only — see McpServerSpec's docs.
export function buildMcpConfig(servers: McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = {
      type: "http",
      url: s.url,
      ...(s.bearerToken
        ? { headers: { authorization: `Bearer ${s.bearerToken}` } }
        : {}),
    };
  }
  return JSON.stringify({ mcpServers });
}

export function buildClaudeArgs(opts: ExecOptions): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    // stream-json only emits the full frame set with --verbose; both the SDK
    // and lvshu pass it unconditionally.
    "--verbose",
    "--include-partial-messages",
  ];

  if (needsStdinProtocol(opts)) {
    args.push("--input-format", "stream-json");
  }
  // `stdio` is a sentinel, not a tool name: it tells the CLI to ask over the
  // stdio control protocol rather than call an MCP tool. Undocumented (absent
  // from --help) but verified working.
  if (opts.onPermissionAsk) {
    args.push("--permission-prompt-tool", "stdio");
  }

  // cc-webui and the CLI share this vocabulary verbatim (`default` verified
  // accepted alongside the --help-documented `manual`).
  if (opts.mode) args.push("--permission-mode", opts.mode);
  // Family aliases (`opus`, `sonnet`, …) are resolved server-side to the
  // current version — that's the whole point of passing them through.
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  const servers = opts.mcpServers ?? [];
  if (servers.length > 0) {
    args.push("--mcp-config", buildMcpConfig(servers));
    // Without this the CLI also loads the user's own ~/.claude MCP config,
    // which would silently add tools cc-webui never granted.
    args.push("--strict-mcp-config");
  }

  if (opts.allowedTools?.length) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.disallowedTools?.length) {
    args.push("--disallowedTools", opts.disallowedTools.join(","));
  }

  // Positional prompt only in the no-stdin case; otherwise it goes over stdin
  // as a stream-json user message (see writePrompt).
  if (!needsStdinProtocol(opts)) args.push(opts.prompt);

  return args;
}

// The stream-json user message. Mirrors what the SDK built from an async
// prompt generator (see the old server/chat.ts:392-404 shape).
export function buildPromptMessage(opts: ExecOptions): string {
  const content: unknown[] = [];
  if (opts.prompt.trim()) {
    content.push({ type: "text", text: opts.prompt });
  }
  for (const img of opts.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
  });
}

// ─── "API Error" arrives as a synthetic assistant message (lvshu) ───────────
//
// The CLI does NOT report a failed model call as a protocol error. It
// synthesizes an `assistant` message whose text is a human-facing string,
// with `message.model === "<synthetic>"` and `is_api_error_message: true`.
// Downstream code that switches on `type` alone cannot tell it apart from a
// real answer — so the user sees "API Error: Unable to connect to API" as if
// the model had said it. lvshu shipped that bug to production once.
//
// lvshu's measured shapes (CLI 2.1.226):
//   scenario        assistant.error         api_error_status  exit  terminal_reason
//   can't connect   server_error            null              1     api_error
//   529 overload    server_error            529               1     api_error
//   401 auth        authentication_failed   401               1     api_error
//
// ⚠️ Do NOT rely on the `result` event alone: that table is the
// "first request failed" shape. When the stream has already started and then
// breaks (ECONNRESET), result's is_error/terminal_reason are not guaranteed —
// but the synthetic assistant message always arrives. So the criterion is the
// CLI's own internal rule: **is the turn's LAST assistant message an API-error
// carrier?** An error mid-stream followed by a real assistant message means the
// CLI recovered, and that is not a failure.
//
// ⚠️ The CLI does not retry: lvshu measured exactly 1 upstream request against
// a 529 stub. Retrying is the platform's job.

const SYNTHETIC_MODEL = "<synthetic>";
const API_ERROR_TEXT_RE = /^(api error|request failed|unable to connect)/i;

export type ApiFailure = { text: string; kind: string; status: number };

export function claudeApiErrorFrom(frame: unknown): ApiFailure | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f.type !== "assistant") return null;

  const msg = f.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return null;

  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const text = blocks
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as any).type === "text",
    )
    .map((b) => b.text)
    .join("")
    .trim();

  // Primary: the CLI's own flag. Fallback: `<synthetic>` model + error-shaped
  // text — that field is @internal (could be renamed with no notice), so if it
  // drifts we degrade to the old "treat it as content" behavior, never worse.
  if (f.is_api_error_message !== true) {
    if (msg.model !== SYNTHETIC_MODEL || !API_ERROR_TEXT_RE.test(text)) {
      return null;
    }
  }

  const status =
    typeof f.api_error_status === "number" ? f.api_error_status : 0;
  const kind = typeof msg.error === "string" ? msg.error : "";
  return { text, kind, status };
}

// Three progressive fallbacks (first hit wins), so a CLI rename can only cost
// precision, never the classification itself: normalized kind → HTTP status →
// text. The kind field is a CLI-internal enum; the status only exists for HTTP
// failures; some text always exists.
export function classifyApiError(f: ApiFailure): FailureKind {
  if (f.kind === "authentication_failed" || f.kind === "permission_error") {
    return "permanent";
  }
  if (f.kind === "server_error" || f.kind === "overloaded_error") {
    return "transient";
  }
  if (f.status === 401 || f.status === 403 || f.status === 400) {
    return "permanent";
  }
  if (f.status === 429 || f.status === 529 || f.status >= 500) {
    return "transient";
  }
  if (/econnreset|etimedout|enotfound|socket hang up|overloaded/i.test(f.text)) {
    return "transient";
  }
  if (/unauthorized|forbidden|invalid api key|credit/i.test(f.text)) {
    return "permanent";
  }
  return "permanent";
}

export function apiFailureMessage(f: ApiFailure): string {
  if (f.text) return f.text;
  if (f.kind) return `model call failed: ${f.kind}`;
  return "model call failed";
}

// ─── Stale resumed session ──────────────────────────────────────────────────

// Callers self-heal by dropping the handle and replaying full history once.
export function isSessionNotFound(msg: string | undefined): boolean {
  if (!msg) return false;
  return /no conversation found with session id/i.test(msg);
}

// ─── Frame classification helpers ───────────────────────────────────────────

export function sessionIdFrom(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const id = (frame as Record<string, unknown>).session_id;
  return typeof id === "string" && id ? id : undefined;
}

export type ResultSummary = {
  isError: boolean;
  subtype?: string;
  terminalReason?: string;
  error?: string;
};

export function resultSummaryFrom(frame: unknown): ResultSummary | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f.type !== "result") return null;
  // ⚠️ lvshu: `terminal_reason === "api_error"` sets is_error while `subtype`
  // stays "success". Reading subtype alone reports a failure as a success.
  //
  // ⚠️ The reason lives in `errors` (an ARRAY), not `error`. Measured for a
  // stale --resume against CLI 2.1.239:
  //   {"type":"result","subtype":"error_during_execution","is_error":true,
  //    "errors":["No conversation found with session ID: …"]}
  // Reading only `error` yields no reason at all, which silently turned the
  // self-healable "stale session" case into a permanent failure.
  const errors = Array.isArray(f.errors)
    ? f.errors.filter((e): e is string => typeof e === "string")
    : [];
  const single = typeof f.error === "string" ? f.error : undefined;
  // A non-"success" subtype counts as failure too. The SDK-era group runner
  // learned this the hard way: a stale --resume yields
  // subtype "error_during_execution", and treating it as success made the turn
  // report ok with zero content, so the UI showed "(no content)".
  const subtype = typeof f.subtype === "string" ? f.subtype : undefined;
  return {
    isError:
      f.is_error === true ||
      f.terminal_reason === "api_error" ||
      (subtype !== undefined && subtype !== "success"),
    subtype,
    terminalReason:
      typeof f.terminal_reason === "string" ? f.terminal_reason : undefined,
    error: errors.length > 0 ? errors.join("; ") : (single ?? subtype),
  };
}

// Why the run stopped, ranked. ⚠️ lvshu: a terminal reason from the CLI's own
// output BEATS the exit code — cancelling a child also exits non-zero, and a
// turn can complete normally while carrying an error payload.
export function classifyTermination(args: {
  aborted: boolean;
  timedOut: boolean;
  exitCode: number | null;
  spawnError?: string;
  result: ResultSummary | null;
  apiFailure: ApiFailure | null;
  stderrTail: string;
}): ExecResult {
  const { aborted, timedOut, exitCode, spawnError, result, apiFailure } = args;

  if (timedOut) {
    return { status: "timeout", failureKind: "transient", error: "timed out" };
  }
  if (aborted) {
    return { status: "aborted", failureKind: "none", error: "cancelled" };
  }
  if (spawnError) {
    return { status: "failed", failureKind: "permanent", error: spawnError };
  }

  // The synthetic API error is the most reliable failure signal — see above.
  if (apiFailure) {
    return {
      status: "failed",
      failureKind: classifyApiError(apiFailure),
      error: apiFailureMessage(apiFailure),
    };
  }

  if (result?.isError) {
    const error = result.error ?? result.terminalReason ?? "run failed";
    // stderr carries the same reason, so consult it as a fallback in case the
    // `errors` field is ever renamed — same layered-fallback idea as the API
    // error classifier.
    const stale = isSessionNotFound(error) || isSessionNotFound(args.stderrTail);
    return {
      status: "failed",
      failureKind: stale ? "transient" : "permanent",
      error,
      sessionNotFound: stale,
    };
  }
  if (result) return { status: "completed", failureKind: "none" };

  // No result event at all — the process died before finishing.
  const error = args.stderrTail.trim() || `exited with code ${exitCode}`;
  const status: RunStatus = "failed";
  return {
    status,
    failureKind: isSessionNotFound(error) ? "transient" : "permanent",
    error,
    sessionNotFound: isSessionNotFound(error),
  };
}

// ─── The executor ───────────────────────────────────────────────────────────

// Bounded so a runaway stderr can't grow without limit; only the tail is ever
// used, and only when no result event arrived.
const STDERR_TAIL_MAX = 4096;

// How long to wait for the CLI to exit on its own after the turn's result
// event before killing it.
const EXIT_GRACE_MS = 5_000;

function autoAllowPrefixes(servers: McpServerSpec[]): string[] {
  return servers.filter((s) => s.autoAllow).map((s) => `mcp__${s.name}__`);
}

export const claudeExecutor: Executor = {
  id: "claude",

  async describe() {
    const bin = resolveClaudeBin();
    const version = await new Promise<string>((resolve) => {
      execFile(bin, ["--version"], { timeout: 15_000 }, (err, stdout) => {
        resolve(err ? "unknown" : stdout.trim());
      });
    });
    return { bin, version };
  },

  async *exec(opts: ExecOptions): AsyncGenerator<ExecFrame, void, void> {
    const bin = resolveClaudeBin();
    const args = buildClaudeArgs(opts);
    const useStdin = needsStdinProtocol(opts);
    const allowPrefixes = autoAllowPrefixes(opts.mcpServers ?? []);

    let aborted = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let exitCode: number | null = null;
    let stderrTail = "";
    let sessionHandle: string | undefined;
    let result: ResultSummary | null = null;
    // Tracks only the LAST assistant message's API-error status — a mid-stream
    // error followed by a real answer means the CLI recovered.
    let apiFailure: ApiFailure | null = null;

    // Push/pull bridge: readline pushes lines, the generator pulls frames.
    const queue: ExecFrame[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    const push = (f: ExecFrame) => {
      queue.push(f);
      notify?.();
    };
    const finish = () => {
      done = true;
      notify?.();
    };

    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    // AbortSignal is deliberately not passed to spawn(): we need to know that
    // *we* killed it, so the result says "aborted" instead of "failed".
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : undefined;

    let graceTimer: NodeJS.Timeout | undefined;

    const writeLine = (obj: unknown) => {
      if (child.stdin.destroyed || !child.stdin.writable) return;
      child.stdin.write(JSON.stringify(obj) + "\n");
    };

    const endStdin = () => {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end();
    };

    const answerPermission = async (
      requestId: string,
      req: Record<string, unknown>,
    ) => {
      const toolName = typeof req.tool_name === "string" ? req.tool_name : "";
      const input = (req.input ?? {}) as Record<string, unknown>;
      let answer: PermissionAnswer;
      try {
        // Adapter namespaces are granted up front — see McpServerSpec.autoAllow.
        if (allowPrefixes.some((p) => toolName.startsWith(p))) {
          answer = { behavior: "allow", updatedInput: input };
        } else if (!opts.onPermissionAsk) {
          answer = { behavior: "deny", message: "no permission handler" };
        } else {
          answer = await opts.onPermissionAsk({
            toolName,
            input,
            toolUseId:
              typeof req.tool_use_id === "string" ? req.tool_use_id : undefined,
            displayName:
              typeof req.display_name === "string" ? req.display_name : undefined,
            description:
              typeof req.description === "string" ? req.description : undefined,
            suggestions: Array.isArray(req.permission_suggestions)
              ? (req.permission_suggestions as PermissionUpdate[])
              : undefined,
            signal: opts.signal,
          });
        }
      } catch (err) {
        answer = {
          behavior: "deny",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      writeLine({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: answer },
      });
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let frame: unknown;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        // Non-JSON noise on stdout — skip it, as lvshu does. Never fatal.
        return;
      }

      sessionHandle = sessionIdFrom(frame) ?? sessionHandle;

      const obj = frame as Record<string, unknown>;

      if (obj.type === "control_request") {
        const requestId =
          typeof obj.request_id === "string" ? obj.request_id : "";
        const req = (obj.request ?? {}) as Record<string, unknown>;
        if (req.subtype === "can_use_tool") {
          void answerPermission(requestId, req);
        } else if (requestId) {
          // Unknown subtype (hooks / sdk-mcp, neither of which we declare).
          // Answer anyway so the CLI is never left blocking on us.
          writeLine({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: requestId,
              error: `unsupported control subtype: ${String(req.subtype)}`,
            },
          });
        }
        // Control traffic is protocol plumbing, not conversation — the caller
        // learns about permissions through onPermissionAsk instead.
        return;
      }

      if (obj.type === "assistant") {
        const failure = claudeApiErrorFrom(frame);
        // Latest assistant message wins: a real answer clears an earlier error.
        apiFailure = failure;
        // Never forward a synthetic error as content — that's the bug this
        // whole detector exists to prevent.
        if (failure) return;
      }

      const summary = resultSummaryFrom(frame);
      if (summary) {
        result = summary;
        // The turn is over, so no further control_request can arrive — and with
        // `--input-format stream-json` the CLI keeps waiting for more input
        // until stdin closes. Measured: without this the process lingers until
        // the timeout even though the answer already streamed out. Closing here
        // is semantically exact, not a workaround.
        endStdin();
        // Belt and suspenders: if it still hasn't exited, don't leak a child
        // process per turn in a long-lived server.
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            if (!closed) child.kill("SIGTERM");
          }, EXIT_GRACE_MS);
        }
      }

      push({ kind: "raw", payload: frame });
    };

    const rl = createInterface({ input: child.stdout });
    rl.on("line", handleLine);

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX);
    });

    child.on("error", (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
      finish();
    });

    let closed = false;
    const onClose = (code: number | null) => {
      if (closed) return;
      closed = true;
      exitCode = code;
      finish();
    };
    // Wait for stdout to drain (`close`), not just process exit, so no trailing
    // frames are dropped.
    child.on("close", onClose);

    if (useStdin) {
      writeLine(JSON.parse(buildPromptMessage(opts)));
      // stdin stays open: the control protocol answers on it mid-turn.
    } else {
      endStdin();
    }

    try {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = null;
            resolve();
          };
        });
      }
      while (queue.length > 0) yield queue.shift()!;

      const res = classifyTermination({
        aborted,
        timedOut,
        exitCode,
        spawnError,
        result,
        apiFailure,
        stderrTail,
      });
      yield {
        kind: "ended",
        result: {
          ...res,
          // Never hand back a handle we just learned is dead — a caller that
          // persisted it would resume the same dead session forever and the
          // self-heal would never converge. (The SDK-era runner cleared it for
          // exactly this reason: server/groups/claude-runner.ts:234.)
          sessionHandle: res.sessionNotFound ? undefined : sessionHandle,
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal.removeEventListener("abort", onAbort);
      rl.close();
      if (!closed) child.kill("SIGKILL");
    }
  },
};
