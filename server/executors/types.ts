// Provider-neutral CLI executor contract.
//
// An **executor** drives one CLI subprocess (`claude` / `codex`) for one turn:
// it builds argv, spawns, frames the process's stdout into events, answers the
// CLI's mid-turn control requests, and classifies how the run ended.
//
// An executor is NOT a **runner**. `server/groups/claude-runner.ts` runs one
// step of a group pipeline and emits `ChatEvent`; it *uses* an executor. Two
// different layers, two different words — see AGENTS.md.
//
// Shape borrowed from lvshu's `agent.Backend` / `agent.Session`
// (`~/code/ts/lvshu/server/internal/agent/agent.go:16-19,60-63`), adapted:
//   - lvshu's two Go channels (Messages + Result) collapse into one async
//     generator that yields many `raw` frames then exactly one `ended`.
//   - lvshu normalizes into its own `Message`/`MessageType`. We deliberately
//     do NOT: cc-webui already has `ChatEvent`, and its raw provider frames are
//     folded by the *same* function on client and server (see
//     `server/groups/runner-types.ts`). Introducing a second normalized shape
//     would mean stream-json → Message → ChatEvent, two mappings instead of one.
//   - lvshu's `RunStatus` has a fifth state, `deferred`. That exists precisely
//     because lvshu does NOT block on a human (its human-in-the-loop runs
//     through `tool_deferred` + an env var + a server hook). cc-webui blocks
//     mid-turn on the control protocol, so it can never defer — the state is
//     omitted rather than left permanently unreachable.
//
// Both `claude` and `codex` executors implement this. Everything
// provider-specific (flag names, mode vocabularies, resume syntax) is
// translated *inside* an executor, never leaked into these types.

import type { PermissionUpdate } from "./permission-types.ts";
// Reused rather than redeclared — server/groups/runner-types.ts already
// imports from src/lib, so this direction is an established pattern.
import type { ImageAttachment } from "../../src/lib/types.ts";

export type ExecutorId = "claude" | "codex";

// ─── How a run ended ────────────────────────────────────────────────────────

// `aborted` vs `timeout` vs `failed` cannot be recovered from a subprocess exit
// code alone — cancelling a child also exits non-zero. Each executor must
// distinguish them from its own cancellation cause, and a terminal event in the
// CLI's own output takes precedence over the exit code (a turn can complete
// normally while carrying an error payload).
export type RunStatus = "completed" | "failed" | "aborted" | "timeout";

// Is a retry worth attempting? `transient` means "same call may succeed";
// `permanent` means "don't bother". Purely advisory — the caller decides.
export type FailureKind = "none" | "transient" | "permanent";

export type ExecResult = {
  status: RunStatus;
  failureKind: FailureKind;
  // Human-facing reason. Present whenever status !== "completed".
  error?: string;
  // Provider handle for resuming the conversation next turn: a Claude session
  // id or a Codex thread id. Harvested from the stream, not from argv — the CLI
  // may issue a different one than we asked for.
  sessionHandle?: string;
  // True when the run failed *specifically* because the handle we passed to
  // `resume` no longer exists on disk. Callers self-heal by forgetting the
  // handle and replaying full history once. This is the one concrete case
  // behind `failureKind: "transient"`.
  sessionNotFound?: boolean;
};

// ─── Stream ─────────────────────────────────────────────────────────────────

// `raw.payload` is the provider's own event, verbatim and unparsed beyond one
// JSON.parse. For Claude that's a `--output-format stream-json` frame; for
// Codex a `codex exec --experimental-json` JSONL line. Both are what the
// frontend's `applySDKMessage` already consumes.
export type ExecFrame =
  | { kind: "raw"; payload: unknown }
  | { kind: "ended"; result: ExecResult };

// ─── Mid-turn permission ask ────────────────────────────────────────────────

// The CLI blocks — indefinitely — while this promise is pending. That is the
// whole point: it's what lets a permission card wait for a human.
//
// Claude implements this over the control protocol
// (`--permission-prompt-tool stdio` + `control_request`/`control_response`).
// Codex has no equivalent on `codex exec` today, so its executor may leave
// `onPermissionAsk` unused.
// Field set measured from a real `can_use_tool` control_request (CLI 2.1.239):
//   { subtype, tool_name, display_name, input, description,
//     permission_suggestions, tool_use_id }
export type PermissionAsk = (req: {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  // Human-facing labels for the permission card.
  displayName?: string;
  description?: string;
  // The SDK's canUseTool exposed a `title`; CLI 2.1.239 does not send one, so
  // this is currently always undefined. Kept so a future CLI that adds it needs
  // no signature change.
  title?: string;
  // Provider-supplied "you could grant this for the session" hints, echoed back
  // untouched in `updatedPermissions`.
  suggestions?: readonly PermissionUpdate[];
  // Aborted when the turn is cancelled while a card is still open.
  signal: AbortSignal;
}) => Promise<PermissionAnswer>;

export type PermissionAnswer =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
  | { behavior: "deny"; message: string };

// ─── MCP ────────────────────────────────────────────────────────────────────

// Executors reach MCP servers over HTTP, never in-process: the CLI's
// parent-process ("sdk") MCP transport rides an undocumented control-protocol
// tunnel we choose not to reimplement, and cc-webui's servers must stay in this
// process anyway (the bash task registry is read live by /api/bash/tasks; the
// lark server is built per-turn bound to one chat). See docs/cli-migration.md.
export type McpServerSpec = {
  // Namespace the CLI will expose tools under, i.e. `mcp__<name>__<tool>`.
  name: string;
  url: string;
  bearerToken?: string;
  // Auto-allow every tool in this namespace without a permission ask. Adapter
  // servers set this; it does NOT make the tools safe, only unprompted.
  autoAllow?: boolean;
};

// ─── Options ────────────────────────────────────────────────────────────────

// cc-webui's own vocabulary. Each executor translates into its provider's
// flags; callers never learn provider flag names.
export type ExecOptions = {
  prompt: string;
  cwd: string;

  // base64 attachments, provider-agnostic at this layer. The two CLIs take
  // images in genuinely different ways and each executor owns the translation
  // AND its cleanup (the generator's finally block):
  //   - claude: inlined as `{type:"image",source:{type:"base64",…}}` content
  //     blocks in the streamed prompt (see server/chat.ts:392-404)
  //   - codex: must be spilled to real files on disk and passed as `-i/--image`
  //     paths, then the temp dir removed (see server/codex-chat.ts:210+)
  // Provider-specific limits (Codex caps size and rejects unknown mime types)
  // surface as `status: "failed"`, not as a thrown exception.
  images?: ImageAttachment[];
  // Cancels the run. Executors must kill the child and report
  // `status: "aborted"` — not "failed" — when this fires.
  signal: AbortSignal;

  // Claude accepts family aliases (`opus`, `sonnet`, …) and resolves them
  // server-side to the current version; Codex requires exact ids.
  model?: string;
  // cc-webui effort tier (`low`..`max`). Neither CLI validates this — an
  // unknown tier is silently accepted — so callers must not rely on rejection.
  effort?: string;
  // cc-webui permission mode (`default` | `auto` | `acceptEdits` | `plan` |
  // `bypassPermissions` | `dontAsk`), translated per provider.
  mode?: string;

  // Provider handle from a previous turn, if resuming.
  resume?: string;

  mcpServers?: McpServerSpec[];
  disallowedTools?: string[];
  allowedTools?: string[];
  appendSystemPrompt?: string;

  // Wall-clock cap. Exceeding it yields `status: "timeout"`, distinct from a
  // caller abort.
  /**
   * 追加到子进程环境里的变量（覆盖同名的 process.env）。
   *
   * ⚠️ 加它的唯一动机是 `MCP_TOOL_TIMEOUT`：**CLI 侧的 MCP 工具超时默认是 60 秒**
   * （2026-08-30 实测，CLI 2.1.251：工具在第 30/60 秒各发一帧 tool_progress，
   * 第 60 秒返回 "The operation timed out."）。桌面客户端那条链上有需要等人的工具
   * （扫码登录），60 秒必然不够 —— 而这个值只能通过环境变量调。
   *
   * 别把它当通用的 env 注入口用：spawn 本来就继承 process.env，这里只放
   * 「这一个 turn 才成立」的东西。
   */
  extraEnv?: Record<string, string>;

  timeoutMs?: number;

  onPermissionAsk?: PermissionAsk;
};

// ─── The contract ───────────────────────────────────────────────────────────

export interface Executor {
  readonly id: ExecutorId;

  // Resolved binary + its reported version. Logged at startup: the CLIs'
  // control protocol is undocumented and unversioned (no handshake, no
  // version check), so when a CLI auto-updates and breaks permission cards or
  // MCP, this line is the only breadcrumb. See docs/cli-migration.md.
  describe(): Promise<{ bin: string; version: string }>;

  // Yields every provider frame, then exactly one `ended`. Must always yield
  // an `ended` frame — including on spawn failure, abort, and timeout — so
  // callers never have to infer termination from generator completion.
  exec(opts: ExecOptions): AsyncGenerator<ExecFrame, void, void>;
}
