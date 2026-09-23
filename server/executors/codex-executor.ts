// Codex CLI executor — drives `codex exec` as a subprocess, no SDK.
//
// Replaces `@openai/codex-sdk`. That SDK was a ~250-line transparent wrapper
// around the very same command line (`dist/index.js:174` builds
// `["exec","--experimental-json", …]`, `:250` spawns, prompt on stdin, stdout
// read with readline) — except it spawned a **version-pinned bundled binary**
// (`@openai/codex-darwin-arm64` 0.142.5) instead of the `codex` the machine
// actually has (0.144.1 here). Driving the CLI directly is what makes the
// integration follow the installed version. See docs/cli-migration.md.
//
// Second implementation of `Executor` — read `claude-executor.ts` first; this
// file only documents where Codex genuinely differs:
//   - no control protocol at all. `codex exec` cannot ask mid-turn, so
//     `onPermissionAsk` is never called and `mode` maps to a sandbox only.
//   - the resume handle is a *subcommand argument* (`exec … resume <id>`),
//     not a flag.
//   - images must be real files on disk (`--image <path>`), so this executor
//     spills them to a temp dir and removes it in `finally`.
//   - everything that has no CLI flag (MCP servers, reasoning effort,
//     approval policy) is passed as `-c <dotted.key>=<toml value>`.

import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ExecFrame,
  ExecOptions,
  ExecResult,
  Executor,
  FailureKind,
  McpServerSpec,
} from "./types.ts";
import type { ImageAttachment } from "../../src/lib/types.ts";

// ─── Binary resolution ──────────────────────────────────────────────────────

// Same contract as resolveClaudeBin: unset → follow PATH (version tracking is
// the point of the migration), set → pin one binary as the escape hatch.
export function resolveCodexBin(): string {
  const raw = process.env.CC_WEBUI_CODEX_BIN?.trim();
  return raw || "codex";
}

// ⚠️ Undocumented: `codex exec --help` (0.144.1) lists only `--json`. We use
// `--experimental-json` deliberately (decision #14) because its frames are
// byte-identical to what the SDK yielded, so src/lib/processor.ts's Codex
// branch needs zero changes. Verified still present on 0.144.1.
// It is exported and logged at startup so that the day it disappears, the
// breadcrumb is in the server log rather than in a mystery empty stream.
export const CODEX_JSON_FLAG = "--experimental-json";

// ─── Vocabulary translation ─────────────────────────────────────────────────

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

// ⚠️ cc-webui's `mode` only reaches Codex as a **sandbox**, never as approvals.
//
// This is not laziness: `codex exec` has no approval channel at all. `-a/--ask-
// for-approval` exists solely on the interactive TUI, and the
// `--experimental-json` event set has no approval request in it (checked
// against the SDK's own `ThreadEvent` union: thread.started / turn.* / item.* /
// error — nothing else). Anything other than `approval_policy="never"` would
// therefore either hang the turn or auto-reject the tool, with no way for a
// permission card to answer.
//
// So `default` cannot mean "ask" here, and the UI saying otherwise is a
// docs/UI problem (AGENTS.md already lists it), not something this layer can
// fix. Making it *look* fixed by sending "on-request" would be strictly worse.
export function mapSandbox(mode: string | undefined): CodexSandbox {
  if (mode === "plan") return "read-only";
  if (mode === "bypassPermissions") return "danger-full-access";
  return "workspace-write";
}

// cc-webui tiers → Codex's. `max` is a Claude-only label (settings.ts hides it
// for Codex); fold it onto xhigh rather than passing a value Codex never
// defined — like Claude's CLI, Codex does not validate this, so a typo would
// be accepted silently.
export function mapEffort(effort: string | undefined): string {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "xhigh" || effort === "max") return "xhigh";
  return "medium";
}

// ─── `-c key=value` overrides ───────────────────────────────────────────────

// TOML value rendering, same rules as the SDK's `toTomlValue`
// (dist/index.js:341). Only strings are needed here; JSON.stringify happens to
// produce valid TOML basic strings.
function tomlString(v: string): string {
  return JSON.stringify(v);
}

// The bearer token is passed through the **environment**, never argv:
// `/proc`-equivalents and `ps` make argv world-readable, and an MCP token is
// "equivalent to a shell" (AGENTS.md, 安全边界). Codex supports exactly this
// via `bearer_token_env_var`, which is why the env var name — not the token —
// is what lands in the command line.
//
// One variable per server rather than a single shared one: `McpServerSpec`
// allows per-server tokens, and today's callers happening to pass the same
// token everywhere is not something this layer should bake in.
export function mcpTokenEnvVar(serverName: string): string {
  const slug = serverName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return `CC_WEBUI_MCP_TOKEN_${slug}`;
}

export function mcpConfigOverrides(servers: McpServerSpec[]): string[] {
  const out: string[] = [];
  for (const s of servers) {
    out.push(`mcp_servers.${s.name}.url=${tomlString(s.url)}`);
    if (s.bearerToken) {
      out.push(
        `mcp_servers.${s.name}.bearer_token_env_var=${tomlString(mcpTokenEnvVar(s.name))}`,
      );
    }
    // ⚠️ Not the same knob as `autoAllow`, which is about cc-webui's own
    // permission cards. With `approval_policy="never"` and no approval channel,
    // a non-"approve" default here does not produce a prompt — it produces a
    // *rejected* tool call. So every server we hand Codex gets it, exactly as
    // the SDK-era createCodexMcpConfig did for bash and lark.
    out.push(`mcp_servers.${s.name}.default_tools_approval_mode="approve"`);
  }
  return out;
}

export function buildConfigOverrides(opts: ExecOptions): string[] {
  return [
    ...mcpConfigOverrides(opts.mcpServers ?? []),
    // See mapSandbox: the only survivable value on `codex exec`.
    `approval_policy="never"`,
    `model_reasoning_effort=${tomlString(mapEffort(opts.effort))}`,
  ];
}

// ─── argv ───────────────────────────────────────────────────────────────────

export function buildCodexArgs(
  opts: ExecOptions,
  imagePaths: string[] = [],
): string[] {
  const args = ["exec", CODEX_JSON_FLAG];

  for (const override of buildConfigOverrides(opts)) {
    args.push("--config", override);
  }

  // Codex has no family aliases — an exact id or nothing. Omitting it lets the
  // user's ~/.codex/config.toml `model` win, which is the historical behavior.
  if (opts.model) args.push("--model", opts.model);
  args.push("--sandbox", mapSandbox(opts.mode));
  args.push("--cd", opts.cwd);
  // cc-webui opens arbitrary directories; refusing to run outside a git repo
  // would break most of them. (The SDK hard-coded this too.)
  args.push("--skip-git-repo-check");

  // ⚠️ `resume` is a SUBCOMMAND, not a flag: everything after it is parsed by
  // the subcommand. Every option above must therefore stay before it — which
  // is fine, clap accepts the parent's options there, and it is exactly what
  // the SDK did (dist/index.js:225) and what production has been running.
  if (opts.resume) args.push("resume", opts.resume);

  // ⚠️ Images go last and NOTHING positional may ever follow them: on `codex
  // exec` the flag is `-i, --image <FILE>...` — variadic, i.e. the same
  // argument-eating shape that bit buildClaudeArgs (see its comment and
  // docs/cli-migration.md). We are safe only because the prompt travels on
  // stdin; if a positional prompt is ever added here, it must go before this.
  for (const p of imagePaths) args.push("--image", p);

  return args;
}

// ─── Images ─────────────────────────────────────────────────────────────────

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class CodexImageError extends Error {}

// Non-images are skipped (both former call sites filtered them out, and
// cc-webui uploads non-image files to /tmp instead of attaching them). An
// attachment that IS an image but that Codex cannot take is a hard failure:
// silently dropping a picture the user attached makes the model answer about
// something it never saw. Surfaces as `status: "failed"`, per ExecOptions.images.
export async function spillImages(
  images: ImageAttachment[] | undefined,
  dir: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const img of images ?? []) {
    if (!img?.mediaType?.startsWith("image/")) continue;
    const ext = IMAGE_EXT_BY_MIME[img.mediaType.toLowerCase()];
    if (!ext) {
      throw new CodexImageError(`unsupported image type: ${img.mediaType}`);
    }
    const buf = Buffer.from(img.data, "base64");
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
      throw new CodexImageError(
        `image ${img.name ?? ""} exceeds ${MAX_IMAGE_BYTES} bytes`,
      );
    }
    const file = path.join(dir, `${randomUUID()}${ext}`);
    await fs.writeFile(file, buf, { mode: 0o600 });
    paths.push(file);
  }
  return paths;
}

// ─── Frame classification ───────────────────────────────────────────────────

export function threadIdFrom(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const f = frame as Record<string, unknown>;
  if (f.type !== "thread.started") return undefined;
  const id = f.thread_id;
  return typeof id === "string" && id ? id : undefined;
}

export type CodexTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: string };

// Measured on 0.144.1 (`codex exec --experimental-json`):
//   {"type":"thread.started","thread_id":"01a0…"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{…}}
//   {"type":"turn.completed","usage":{…}}
// and on a rejected model, `{"type":"error","message":"{…\"status\":400…}"}`
// immediately followed by `{"type":"turn.failed","error":{"message":…}}`.
export function turnOutcomeFrom(frame: unknown): CodexTurnOutcome | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f.type === "turn.completed") return { kind: "completed" };
  if (f.type === "turn.failed") {
    const err = f.error as Record<string, unknown> | undefined;
    const msg = typeof err?.message === "string" ? err.message : "turn failed";
    return { kind: "failed", error: msg };
  }
  return null;
}

// A standalone `{"type":"error","message":…}` (the SDK's ThreadErrorEvent).
// It normally precedes turn.failed, but is kept as a fallback for the case
// where the process dies before emitting the terminal frame.
export function errorMessageFrom(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const f = frame as Record<string, unknown>;
  if (f.type !== "error") return undefined;
  return typeof f.message === "string" ? f.message : "codex error";
}

// ─── Stale resumed thread ───────────────────────────────────────────────────

// Codex's wording for "that thread id is gone", measured on 0.144.1:
//   Error: thread/resume: thread/resume failed: no rollout found for thread id
//   00000000-… (code -32600)
// ⚠️ It arrives on **stderr only**, with exit code 1 and not a single JSON
// frame on stdout — so unlike the Claude path there is no `result` event to
// read the reason from. This is the whole reason classifyCodexTermination
// consults the stderr tail.
export function isThreadNotFound(msg: string | undefined): boolean {
  if (!msg) return false;
  return /no rollout found for thread|thread\/resume failed/i.test(msg);
}

// Is retrying worth it? Same layered-fallback idea as classifyApiError: the
// most specific signal first, then HTTP status, then wording.
export function classifyCodexError(msg: string): FailureKind {
  if (isThreadNotFound(msg)) return "transient";
  if (/\b(429|5\d\d)\b/.test(msg)) return "transient";
  if (
    /rate.?limit|overloaded|temporarily unavailable|econnreset|etimedout|enotfound|socket hang up|network error/i.test(
      msg,
    )
  ) {
    return "transient";
  }
  // "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT
  // account." arrives as a 400 — retrying it forever helps nobody.
  if (/\b(400|401|403|404)\b/.test(msg)) return "permanent";
  if (/not supported|unauthorized|forbidden|invalid|authentication/i.test(msg)) {
    return "permanent";
  }
  return "permanent";
}

export function classifyCodexTermination(args: {
  aborted: boolean;
  timedOut: boolean;
  exitCode: number | null;
  spawnError?: string;
  outcome: CodexTurnOutcome | null;
  lastError?: string;
  stderrTail: string;
}): ExecResult {
  const { aborted, timedOut, exitCode, spawnError, outcome, lastError } = args;

  if (timedOut) {
    return { status: "timeout", failureKind: "transient", error: "timed out" };
  }
  if (aborted) {
    return { status: "aborted", failureKind: "none", error: "cancelled" };
  }
  if (spawnError) {
    return { status: "failed", failureKind: "permanent", error: spawnError };
  }

  // The CLI's own terminal frame beats the exit code (lvshu's lesson, same as
  // the Claude side): `codex exec` exits 1 on a failed turn, but it also exits
  // non-zero when *we* killed it.
  if (outcome?.kind === "failed") {
    return {
      status: "failed",
      failureKind: classifyCodexError(outcome.error),
      error: outcome.error,
      sessionNotFound: isThreadNotFound(outcome.error),
    };
  }
  if (outcome?.kind === "completed") {
    return { status: "completed", failureKind: "none" };
  }

  // No terminal frame: the process died first. The reason is on stderr — this
  // is the stale-resume path.
  const error = lastError || args.stderrTail.trim() || `exited with code ${exitCode}`;
  const stale = isThreadNotFound(error);
  return {
    status: "failed",
    failureKind: classifyCodexError(error),
    error,
    sessionNotFound: stale,
  };
}

// ─── The executor ───────────────────────────────────────────────────────────

const STDERR_TAIL_MAX = 4096;

// `codex exec` announces this on stderr whenever the prompt comes from stdin,
// which for us is always. Dropping it keeps the stderr tail usable as an error
// message instead of always leading with a status line.
const STDERR_NOISE = /^Reading prompt from stdin\.\.\.\s*$/;

export const codexExecutor: Executor = {
  id: "codex",

  async describe() {
    const bin = resolveCodexBin();
    const version = await new Promise<string>((resolve) => {
      execFile(bin, ["--version"], { timeout: 15_000 }, (err, stdout) => {
        resolve(err ? "unknown" : stdout.trim());
      });
    });
    return { bin, version };
  },

  async *exec(opts: ExecOptions): AsyncGenerator<ExecFrame, void, void> {
    const bin = resolveCodexBin();

    // Created unconditionally (mkdtemp is cheap) so the cleanup path has one
    // shape. Owned by this generator — see ExecOptions.images.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-codex-"));
    let imagePaths: string[];
    try {
      imagePaths = await spillImages(opts.images, tmpDir);
    } catch (err) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      yield {
        kind: "ended",
        result: {
          status: "failed",
          failureKind: "permanent",
          error: err instanceof Error ? err.message : String(err),
        },
      };
      return;
    }

    const args = buildCodexArgs(opts, imagePaths);

    let aborted = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let exitCode: number | null = null;
    let stderrTail = "";
    let threadId: string | undefined;
    let outcome: CodexTurnOutcome | null = null;
    let lastError: string | undefined;

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
      env: {
        ...process.env,
        // Per-server bearer tokens, referenced from argv by name only.
        ...Object.fromEntries(
          (opts.mcpServers ?? [])
            .filter((s) => s.bearerToken)
            .map((s) => [mcpTokenEnvVar(s.name), s.bearerToken!]),
        ),
        ...opts.extraEnv,
      },
    });

    // Not spawn's own `signal` option, for the same reason as the Claude
    // executor: we must know that *we* killed it, so the result can say
    // "aborted" rather than "failed".
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

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let frame: unknown;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        // Non-JSON noise on stdout — skip, never fatal (lvshu claude.go:224).
        return;
      }
      threadId = threadIdFrom(frame) ?? threadId;
      outcome = turnOutcomeFrom(frame) ?? outcome;
      lastError = errorMessageFrom(frame) ?? lastError;
      push({ kind: "raw", payload: frame });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const kept = chunk
        .toString()
        .split("\n")
        .filter((l) => !STDERR_NOISE.test(l))
        .join("\n");
      if (kept.trim()) stderrTail = (stderrTail + kept).slice(-STDERR_TAIL_MAX);
    });

    child.on("error", (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
      finish();
    });

    let closed = false;
    // `close`, not `exit`: wait for stdout to drain so no trailing frame — in
    // particular turn.completed — is dropped.
    child.on("close", (code) => {
      if (closed) return;
      closed = true;
      exitCode = code;
      finish();
    });

    // The prompt is the whole stdin, then EOF. Unlike Claude there is no
    // control protocol, so nothing needs stdin to stay open — and `codex exec`
    // will not start until it sees EOF.
    if (!child.stdin.destroyed && child.stdin.writable) {
      child.stdin.end(opts.prompt);
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

      const res = classifyCodexTermination({
        aborted,
        timedOut,
        exitCode,
        spawnError,
        outcome,
        lastError,
        stderrTail,
      });
      // On resume the CLI does not necessarily re-announce the thread, so fall
      // back to the handle we were given — but never hand back one we just
      // learned is dead, or the caller persists it and the self-heal never
      // converges (same rule as the Claude executor).
      const handle = threadId ?? opts.resume;
      yield {
        kind: "ended",
        result: {
          ...res,
          sessionHandle: res.sessionNotFound ? undefined : handle,
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      rl.close();
      if (!closed) child.kill("SIGKILL");
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
