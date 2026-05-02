import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export type TaskStatus = "running" | "completed" | "killed" | "failed";

interface BackgroundTask {
  id: string;
  sessionId: string | undefined;
  command: string;
  cwd: string | undefined;
  startedAt: number;
  finishedAt: number | null;
  proc: ChildProcess;
  // stdout / stderr are rolling windows of at most MAX_OUTPUT_BYTES chars.
  // Once full, the oldest bytes are sliced off the front as new chunks arrive.
  // *Dropped* counts how many chars have been rolled off in total.
  stdout: string;
  stderr: string;
  stdoutDropped: number;
  stderrDropped: number;
  exitCode: number | null;
  status: TaskStatus;
  truncated: boolean;
  // readStdoutOffset / readStderrOffset store cumulative byte positions in the
  // full stream (dropped + current buffer length), not indices into the current
  // buffer — so they remain meaningful after rollover.
  readStdoutOffset: number;
  readStderrOffset: number;
  endReason: string | null;
  outputSubscribers: Set<TaskOutputSubscriber>;
}

export type TaskOutputEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | {
      type: "status";
      status: TaskStatus;
      exitCode: number | null;
      endReason: string | null;
      finishedAt: number | null;
      truncated: boolean;
    }
  | { type: "done" };

type TaskOutputSubscriber = (ev: TaskOutputEvent) => void;

const tasks = new Map<string, BackgroundTask>();
const sessionAliases = new Map<string, string>();

// Fans out list-level state changes (added / status transitions / sessionId
// relabeling). Subscribers typically re-read listBackgroundTasks() when fired.
const listSubscribers = new Set<() => void>();

export function subscribeListChanges(sub: () => void): () => void {
  listSubscribers.add(sub);
  return () => {
    listSubscribers.delete(sub);
  };
}

function notifyList(): void {
  for (const sub of listSubscribers) {
    try {
      sub();
    } catch {
      /* ignore */
    }
  }
}

export function subscribeTaskOutput(
  id: string,
  sub: TaskOutputSubscriber
): () => void {
  const t = tasks.get(id);
  if (!t) return () => {};
  t.outputSubscribers.add(sub);
  return () => {
    t.outputSubscribers.delete(sub);
  };
}

function notifyTaskOutput(t: BackgroundTask, ev: TaskOutputEvent): void {
  for (const sub of t.outputSubscribers) {
    try {
      sub(ev);
    } catch {
      /* ignore */
    }
  }
}

function emitStatus(t: BackgroundTask): void {
  notifyTaskOutput(t, {
    type: "status",
    status: t.status,
    exitCode: t.exitCode,
    endReason: t.endReason,
    finishedAt: t.finishedAt,
    truncated: t.truncated,
  });
}

function emitDone(t: BackgroundTask): void {
  notifyTaskOutput(t, { type: "done" });
  t.outputSubscribers.clear();
}

// Foreground invocations are tracked so the UI can offer a Ctrl+B "detach to
// background" action while a blocking bash call is in flight. Each entry
// exposes a `detach()` method that hijacks the proc + current buffers into a
// freshly-created BackgroundTask, resolves the foreground Promise with the
// new bashTaskId, and deregisters itself.
export interface ForegroundSummary {
  fgId: string;
  sessionId: string | undefined;
  command: string;
  cwd: string | undefined;
  startedAt: number;
}

interface ForegroundInvocation extends ForegroundSummary {
  detach: () =>
    | { ok: true; bashTaskId: string }
    | { ok: false; reason: string };
}

const foregroundInvocations = new Map<string, ForegroundInvocation>();

type ForegroundEventSubscriber = (event: string, data: string) => void;
const foregroundEventSubscribers = new Set<ForegroundEventSubscriber>();

export function subscribeForegroundEvents(
  sub: ForegroundEventSubscriber
): () => void {
  foregroundEventSubscribers.add(sub);
  return () => {
    foregroundEventSubscribers.delete(sub);
  };
}

function emitForegroundEvent(event: string, data: string): void {
  for (const sub of foregroundEventSubscribers) {
    try {
      sub(event, data);
    } catch {
      /* ignore */
    }
  }
}

function dispatchForegroundEvent(
  local: Options["onForegroundEvent"],
  event: string,
  payload: Record<string, unknown>
): void {
  const data = JSON.stringify(payload);
  local?.(event, data);
  emitForegroundEvent(event, data);
}

export function resolveTaskSessionId(
  sessionId: string | undefined
): string | undefined {
  if (!sessionId) return undefined;
  let current = sessionId;
  const seen = new Set<string>();
  while (sessionAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = sessionAliases.get(current)!;
  }
  return current;
}

export function listForegroundInvocations(filter?: {
  sessionId?: string | null;
}): ForegroundSummary[] {
  const filterSessionId =
    filter && "sessionId" in filter
      ? resolveTaskSessionId(filter.sessionId ?? undefined)
      : undefined;
  const all: ForegroundSummary[] = [];
  for (const inv of foregroundInvocations.values()) {
    if (
      filter &&
      "sessionId" in filter &&
      inv.sessionId !== filterSessionId
    ) {
      continue;
    }
    all.push({
      fgId: inv.fgId,
      sessionId: inv.sessionId,
      command: inv.command,
      cwd: inv.cwd,
      startedAt: inv.startedAt,
    });
  }
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export function detachForegroundToBackground(
  fgId: string
):
  | { ok: true; bashTaskId: string }
  | { ok: false; reason: string } {
  const inv = foregroundInvocations.get(fgId);
  if (!inv) return { ok: false, reason: "not_found" };
  return inv.detach();
}

export function listBackgroundTasks(filter?: {
  sessionId?: string | null;
  // Match any task whose sessionId STARTS WITH this prefix. Used by
  // group chats which scope their bash MCP under `${gid}:${agentId}`
  // — passing `${gid}:` aggregates tasks from all agents in the group.
  sessionPrefix?: string;
}): BackgroundTask[] {
  const filterSessionId =
    filter && "sessionId" in filter
      ? resolveTaskSessionId(filter.sessionId ?? undefined)
      : undefined;
  const prefix = filter?.sessionPrefix;
  const all = Array.from(tasks.values());
  let filtered: BackgroundTask[];
  if (filter && "sessionId" in filter) {
    filtered = all.filter((t) => t.sessionId === filterSessionId);
  } else if (prefix) {
    filtered = all.filter(
      (t) => typeof t.sessionId === "string" && t.sessionId.startsWith(prefix),
    );
  } else {
    filtered = all;
  }
  return filtered.sort((a, b) => b.startedAt - a.startedAt);
}

// When the SDK emits a real session_id mid-stream for a chat that started with
// no sessionId (or a different placeholder), retag any tasks spawned under the
// previous id so they appear under the resolved session in the UI.
export function relabelTasksSessionId(
  from: string | undefined,
  to: string
): void {
  if (from) sessionAliases.set(from, to);
  let changed = false;
  for (const t of tasks.values()) {
    if (t.sessionId === from) {
      t.sessionId = to;
      changed = true;
    }
  }
  for (const inv of foregroundInvocations.values()) {
    if (inv.sessionId === from) {
      inv.sessionId = to;
      changed = true;
    }
  }
  if (changed) notifyList();
}

// Kill every still-running task. Used on server shutdown to avoid orphan bash
// processes surviving past tsx watch restarts.
function killAllRunningTasks(reason: string): void {
  let changed = false;
  for (const t of tasks.values()) {
    if (t.status !== "running") continue;
    try {
      t.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    t.status = "killed";
    t.endReason = reason;
    t.finishedAt = Date.now();
    emitStatus(t);
    emitDone(t);
    changed = true;
  }
  if (changed) notifyList();
}

let shutdownHandlersInstalled = false;
function installShutdownHandlersOnce(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const onSignal = (sig: NodeJS.Signals) => {
    killAllRunningTasks(`server shutdown (${sig})`);
    // Re-raise default behavior: exit with conventional code.
    const code = sig === "SIGINT" ? 130 : sig === "SIGHUP" ? 129 : 143;
    process.exit(code);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  process.once("SIGHUP", onSignal);
  process.on("beforeExit", () => killAllRunningTasks("process beforeExit"));
}
installShutdownHandlersOnce();

export function getBackgroundTaskById(id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

export function killBackgroundTaskById(id: string): {
  ok: boolean;
  reason?: string;
  status: TaskStatus;
} {
  const t = tasks.get(id);
  if (!t) return { ok: false, reason: "not_found", status: "failed" };
  if (t.status !== "running") {
    return { ok: false, reason: "already_" + t.status, status: t.status };
  }
  t.status = "killed";
  t.endReason = "killed via UI";
  t.finishedAt = Date.now();
  t.proc.kill("SIGKILL");
  emitStatus(t);
  notifyList();
  return { ok: true, status: "killed" };
}

interface Options {
  cwd?: string;
  getSessionId?: () => string | undefined;
  // Emits "foreground_started" / "foreground_ended" events into the chat SSE
  // fanout so clients can know which fgId is currently pending (to drive
  // Ctrl+B detach).
  onForegroundEvent?: (event: string, data: string) => void;
}

type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

interface BashRunArgs {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

export function runBashTool(
  args: BashRunArgs,
  opts: Options,
  signal?: AbortSignal
): CallToolResult | Promise<CallToolResult> {
  const sessionId = resolveTaskSessionId(opts.getSessionId?.());
  if (args.run_in_background) {
    return runBackground(args.command, opts.cwd, sessionId);
  }
  return runForeground(
    args.command,
    opts.cwd,
    args.timeout ?? DEFAULT_TIMEOUT_MS,
    signal,
    sessionId,
    opts.onForegroundEvent
  );
}

export function listBackgroundTasksForTool(
  sessionId: string | undefined
): CallToolResult {
  const resolvedSessionId = resolveTaskSessionId(sessionId);
  const items = listBackgroundTasks({
    sessionId: resolvedSessionId ?? null,
  });
  if (items.length === 0) {
    return {
      content: [{ type: "text", text: "No background bash tasks." }],
      isError: false,
    };
  }
  const lines = items.map((t) => {
    const ageMs = (t.finishedAt ?? Date.now()) - t.startedAt;
    const age = `${(ageMs / 1000).toFixed(1)}s`;
    const exit = t.exitCode == null ? "" : ` exit=${t.exitCode}`;
    const reason = t.endReason ? ` [${t.endReason}]` : "";
    return `${t.id} ${t.status}${exit} ${age}${reason}\n  ${t.command}`;
  });
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: false,
  };
}

export function createBashMcpServer(
  opts: Options
): McpSdkServerConfigWithInstance {
  const runTool = tool(
    "run",
    "Execute a bash command in the project working directory. " +
      "Output combines stdout and stderr. Non-zero exit codes are returned as errors. " +
      "Set run_in_background=true to launch asynchronously — you'll get a bashTaskId " +
      "which can be polled with mcp__bash__output or terminated with mcp__bash__kill.",
    {
      command: z.string().describe("The bash command to execute"),
      timeout: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(
          `Optional timeout in ms for foreground runs (max ${MAX_TIMEOUT_MS})`
        ),
      description: z
        .string()
        .optional()
        .describe(
          "Short description (5-10 words) of what this command does, in active voice"
        ),
      run_in_background: z
        .boolean()
        .optional()
        .describe(
          "If true, spawn without waiting; returns a bashTaskId for polling via mcp__bash__output."
        ),
    },
    async (args, extra) => {
      const signal: AbortSignal | undefined = (extra as any)?.signal;
      return runBashTool(args, opts, signal);
    }
  );

  const outputTool = tool(
    "output",
    "Retrieve new stdout/stderr output from a background bash task since the last poll, " +
      "plus the task's current status and exit code (if finished). " +
      "Output is returned incrementally — each call only returns bytes appended since the previous call.",
    {
      bash_id: z
        .string()
        .describe("The bashTaskId returned by run with run_in_background=true"),
    },
    async (args) => readBackgroundOutput(args.bash_id)
  );

  const killTool = tool(
    "kill",
    "Kill a running background bash task by its bashTaskId (sends SIGKILL).",
    {
      bash_id: z
        .string()
        .describe("The bashTaskId returned by run with run_in_background=true"),
    },
    async (args) => killBackground(args.bash_id)
  );

  const listTool = tool(
    "list",
    "List background bash tasks for this conversation, including task id, status, exit code and command.",
    {},
    async () => listBackgroundTasksForTool(opts.getSessionId?.())
  );

  return createSdkMcpServer({
    name: "bash",
    version: "0.2.0",
    tools: [runTool, outputTool, killTool, listTool],
  });
}

function runForeground(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  sessionId: string | undefined,
  onForegroundEvent: Options["onForegroundEvent"]
): Promise<CallToolResult> {
  return new Promise((resolve) => {
    const fgId = "fg-" + randomUUID().slice(0, 8);
    const startedAt = Date.now();
    let settled = false;
    let detachedTo: BackgroundTask | null = null;
    let stdout = "";
    let stderr = "";
    let stdoutDropped = 0;
    let stderrDropped = 0;
    let truncated = false;

    const proc = spawn("bash", ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!settled && !detachedTo) {
        proc.kill("SIGKILL");
        finalize(-1, "timeout");
      }
    }, timeoutMs);

    const abortHandler = () => {
      if (!settled && !detachedTo) {
        proc.kill("SIGKILL");
        finalize(-1, "aborted");
      }
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    // Append to BackgroundTask's rolling buffer (used after detach). Mirrors
    // runBackground's appendOut.
    const appendToTask = (buf: Buffer, target: "stdout" | "stderr") => {
      if (!detachedTo) return;
      const task = detachedTo;
      if (task.status !== "running") return;
      const chunk = buf.toString("utf-8");
      if (!chunk) return;
      const cur = target === "stdout" ? task.stdout : task.stderr;
      const combined = cur + chunk;
      let next = combined;
      let droppedNow = 0;
      if (combined.length > MAX_OUTPUT_BYTES) {
        droppedNow = combined.length - MAX_OUTPUT_BYTES;
        next = combined.slice(droppedNow);
      }
      if (target === "stdout") {
        task.stdout = next;
        task.stdoutDropped += droppedNow;
      } else {
        task.stderr = next;
        task.stderrDropped += droppedNow;
      }
      const firstTruncate = droppedNow > 0 && !task.truncated;
      if (droppedNow > 0) task.truncated = true;
      notifyTaskOutput(task, { type: target, chunk });
      if (firstTruncate) emitStatus(task);
    };

    const appendOut = (buf: Buffer, target: "stdout" | "stderr") => {
      if (detachedTo) {
        appendToTask(buf, target);
        return;
      }
      const chunk = buf.toString("utf-8");
      if (!chunk) return;
      const cur = target === "stdout" ? stdout : stderr;
      const combined = cur + chunk;
      let next = combined;
      let droppedNow = 0;
      if (combined.length > MAX_OUTPUT_BYTES) {
        droppedNow = combined.length - MAX_OUTPUT_BYTES;
        next = combined.slice(droppedNow);
      }
      if (target === "stdout") {
        stdout = next;
        stdoutDropped += droppedNow;
      } else {
        stderr = next;
        stderrDropped += droppedNow;
      }
      if (droppedNow > 0) truncated = true;
    };

    proc.stdout?.on("data", (b) => appendOut(b, "stdout"));
    proc.stderr?.on("data", (b) => appendOut(b, "stderr"));

    proc.on("error", (err) => {
      if (detachedTo) {
        const task = detachedTo;
        if (task.status === "running") {
          task.status = "failed";
          task.endReason = `spawn error: ${err.message}`;
          task.finishedAt = Date.now();
          emitStatus(task);
          emitDone(task);
          notifyList();
        }
        return;
      }
      if (!settled) finalize(-1, `spawn error: ${err.message}`);
    });

    proc.on("close", (code) => {
      if (detachedTo) {
        const task = detachedTo;
        if (task.status === "running") {
          task.exitCode = code ?? 0;
          task.status = code === 0 ? "completed" : "failed";
          if (code !== 0 && !task.endReason)
            task.endReason = `exit code ${code}`;
          task.finishedAt = Date.now();
        } else {
          if (task.exitCode === null) task.exitCode = code ?? 0;
          if (task.finishedAt === null) task.finishedAt = Date.now();
        }
        emitStatus(task);
        emitDone(task);
        notifyList();
        return;
      }
      if (!settled) finalize(code ?? 0, null);
    });

    const detach = ():
      | { ok: true; bashTaskId: string }
      | { ok: false; reason: string } => {
      if (settled) return { ok: false, reason: "already_finished" };
      if (detachedTo)
        return { ok: false, reason: "already_detached" };

      // Resolve to the canonical sessionId at the moment of creation so the
      // task / event are tagged correctly even if a session id migration
      // (relabelTasksSessionId) happened between runForeground entry and detach.
      const liveSessionId = resolveTaskSessionId(sessionId);
      const bgId = "bg-" + randomUUID().slice(0, 8);
      const task: BackgroundTask = {
        id: bgId,
        sessionId: liveSessionId,
        command,
        cwd,
        startedAt,
        finishedAt: null,
        proc,
        stdout,
        stderr,
        stdoutDropped,
        stderrDropped,
        exitCode: null,
        status: "running",
        truncated,
        readStdoutOffset: 0,
        readStderrOffset: 0,
        endReason: null,
        outputSubscribers: new Set(),
      };
      tasks.set(bgId, task);
      detachedTo = task;
      notifyList();

      // Cancel the foreground-specific timers / signal handler. The task now
      // has its own lifecycle.
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);

      // Resolve the foreground Promise immediately so the SDK tool call
      // returns — model gets the new bashTaskId and can keep working.
      settled = true;
      foregroundInvocations.delete(fgId);
      dispatchForegroundEvent(
        onForegroundEvent,
        "foreground_ended",
        {
          type: "foreground_ended",
          fgId,
          sessionId: liveSessionId,
          reason: "detached",
          bashTaskId: bgId,
        }
      );
      resolve({
        content: [
          {
            type: "text",
            text:
              `Detached to background. bashTaskId: ${bgId}\n` +
              `command: ${command}\n` +
              `cwd: ${cwd ?? "(default)"}\n` +
              `Poll with mcp__bash__output (bash_id="${bgId}") or terminate with mcp__bash__kill.`,
          },
        ],
        isError: false,
      });
      return { ok: true, bashTaskId: bgId };
    };

    foregroundInvocations.set(fgId, {
      fgId,
      sessionId,
      command,
      cwd,
      startedAt,
      detach,
    });
    dispatchForegroundEvent(
      onForegroundEvent,
      "foreground_started",
      {
        type: "foreground_started",
        fgId,
        sessionId,
        command,
        cwd,
        startedAt,
      }
    );

    function finalize(exitCode: number, reason: string | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      // Use the live (post-relabel) sessionId — the captured `sessionId`
      // closure may be stale if a Codex thread.started arrived mid-run.
      const liveSessionId = resolveTaskSessionId(sessionId);
      foregroundInvocations.delete(fgId);
      dispatchForegroundEvent(
        onForegroundEvent,
        "foreground_ended",
        {
          type: "foreground_ended",
          fgId,
          sessionId: liveSessionId,
          reason: reason ?? "completed",
        }
      );

      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(stderr);
      if (truncated) {
        const dropNotes: string[] = [];
        if (stdoutDropped > 0)
          dropNotes.push(`stdout: first ${stdoutDropped} chars dropped`);
        if (stderrDropped > 0)
          dropNotes.push(`stderr: first ${stderrDropped} chars dropped`);
        parts.push(
          `\n[rolling window: last ${MAX_OUTPUT_BYTES} chars kept per stream` +
            (dropNotes.length ? ` · ${dropNotes.join("; ")}` : "") +
            `]`
        );
      }
      if (reason === "timeout")
        parts.push(`\n[command timed out after ${timeoutMs}ms]`);
      else if (reason === "aborted")
        parts.push(`\n[command aborted by user/session]`);
      else if (reason) parts.push(`\n[${reason}]`);
      if (exitCode !== 0 && reason === null)
        parts.push(`\n[exit code: ${exitCode}]`);

      const text = parts.join("").trim() || "(no output)";
      resolve({
        content: [{ type: "text", text }],
        isError: exitCode !== 0,
      });
    }
  });
}

function runBackground(
  command: string,
  cwd: string | undefined,
  sessionId: string | undefined
): CallToolResult {
  const id = "bg-" + randomUUID().slice(0, 8);
  const proc = spawn("bash", ["-lc", command], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const task: BackgroundTask = {
    id,
    sessionId: resolveTaskSessionId(sessionId),
    command,
    cwd,
    startedAt: Date.now(),
    finishedAt: null,
    proc,
    stdout: "",
    stderr: "",
    stdoutDropped: 0,
    stderrDropped: 0,
    exitCode: null,
    status: "running",
    truncated: false,
    readStdoutOffset: 0,
    readStderrOffset: 0,
    endReason: null,
    outputSubscribers: new Set(),
  };
  tasks.set(id, task);
  notifyList();

  const appendOut = (buf: Buffer, target: "stdout" | "stderr") => {
    const chunk = buf.toString("utf-8");
    if (!chunk) return;
    const cur = target === "stdout" ? task.stdout : task.stderr;
    const combined = cur + chunk;
    let next = combined;
    let droppedNow = 0;
    if (combined.length > MAX_OUTPUT_BYTES) {
      droppedNow = combined.length - MAX_OUTPUT_BYTES;
      next = combined.slice(droppedNow);
    }
    if (target === "stdout") {
      task.stdout = next;
      task.stdoutDropped += droppedNow;
    } else {
      task.stderr = next;
      task.stderrDropped += droppedNow;
    }
    const firstTruncate = droppedNow > 0 && !task.truncated;
    if (droppedNow > 0) task.truncated = true;
    notifyTaskOutput(task, { type: target, chunk });
    if (firstTruncate) emitStatus(task);
  };

  proc.stdout?.on("data", (b) => appendOut(b, "stdout"));
  proc.stderr?.on("data", (b) => appendOut(b, "stderr"));

  proc.on("error", (err) => {
    if (task.status === "running") {
      task.status = "failed";
      task.endReason = `spawn error: ${err.message}`;
      task.finishedAt = Date.now();
      emitStatus(task);
      emitDone(task);
      notifyList();
    }
  });

  proc.on("close", (code) => {
    if (task.status === "running") {
      task.exitCode = code ?? 0;
      task.status = code === 0 ? "completed" : "failed";
      if (code !== 0 && !task.endReason) task.endReason = `exit code ${code}`;
      task.finishedAt = Date.now();
    } else {
      if (task.exitCode === null) task.exitCode = code ?? 0;
      if (task.finishedAt === null) task.finishedAt = Date.now();
    }
    emitStatus(task);
    emitDone(task);
    notifyList();
  });

  return {
    content: [
      {
        type: "text",
        text:
          `bashTaskId: ${id}\n` +
          `command: ${command}\n` +
          `cwd: ${cwd ?? "(default)"}\n` +
          `Use mcp__bash__output with bash_id="${id}" to poll output, ` +
          `or mcp__bash__kill to terminate.`,
      },
    ],
    isError: false,
  };
}

export function readBackgroundOutput(id: string): CallToolResult {
  const t = tasks.get(id);
  if (!t) {
    return {
      content: [{ type: "text", text: `No background task with id "${id}"` }],
      isError: true,
    };
  }

  // readStdoutOffset / readStderrOffset are cumulative positions. Convert to
  // an index into the current (rolling) buffer by subtracting how much has
  // rolled off. If the poll falls behind the rollover, overrun tells us how
  // many bytes were dropped before this call could see them.
  const stdoutTotal = t.stdoutDropped + t.stdout.length;
  const stderrTotal = t.stderrDropped + t.stderr.length;
  const stdoutOverrun = Math.max(0, t.stdoutDropped - t.readStdoutOffset);
  const stderrOverrun = Math.max(0, t.stderrDropped - t.readStderrOffset);
  const newStdout = t.stdout.slice(
    Math.max(0, t.readStdoutOffset - t.stdoutDropped)
  );
  const newStderr = t.stderr.slice(
    Math.max(0, t.readStderrOffset - t.stderrDropped)
  );
  t.readStdoutOffset = stdoutTotal;
  t.readStderrOffset = stderrTotal;

  const parts: string[] = [];
  const statusLine =
    `status: ${t.status}` +
    (t.exitCode != null ? ` (exit ${t.exitCode})` : "") +
    (t.finishedAt
      ? ` · ran ${((t.finishedAt - t.startedAt) / 1000).toFixed(1)}s`
      : ` · ${((Date.now() - t.startedAt) / 1000).toFixed(1)}s elapsed`);
  parts.push(statusLine);

  if (stdoutOverrun > 0)
    parts.push(
      `[${stdoutOverrun} stdout chars rolled off before this poll]`
    );
  if (newStdout) parts.push("--- stdout ---\n" + newStdout.trimEnd());
  if (stderrOverrun > 0)
    parts.push(
      `[${stderrOverrun} stderr chars rolled off before this poll]`
    );
  if (newStderr) parts.push("--- stderr ---\n" + newStderr.trimEnd());
  if (!newStdout && !newStderr && stdoutOverrun === 0 && stderrOverrun === 0)
    parts.push("(no new output since last poll)");
  if (t.truncated)
    parts.push(
      `[rolling window: only last ${MAX_OUTPUT_BYTES} chars retained per stream]`
    );
  if (t.endReason) parts.push(`[${t.endReason}]`);

  return {
    content: [{ type: "text", text: parts.join("\n") }],
    isError: t.status === "failed",
  };
}

export function killBackground(id: string): CallToolResult {
  const t = tasks.get(id);
  if (!t) {
    return {
      content: [{ type: "text", text: `No background task with id "${id}"` }],
      isError: true,
    };
  }
  if (t.status !== "running") {
    return {
      content: [
        {
          type: "text",
          text: `Task ${id} already ${t.status}${
            t.exitCode != null ? ` (exit ${t.exitCode})` : ""
          }`,
        },
      ],
      isError: false,
    };
  }

  t.status = "killed";
  t.endReason = "killed by mcp__bash__kill";
  t.finishedAt = Date.now();
  t.proc.kill("SIGKILL");
  emitStatus(t);
  notifyList();

  return {
    content: [{ type: "text", text: `Sent SIGKILL to task ${id}` }],
    isError: false,
  };
}
