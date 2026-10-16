// Web single-chat executor. Groups/Feishu retain codex exec. This connection
// is a fresh local stdio process per turn, never a shared/public app-server.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecFrame, ExecOptions, ExecResult, Executor } from "./types.ts";
import { buildConfigOverrides, classifyCodexError, codexExecutor, isThreadNotFound, mapEffort, mapSandbox, mcpTokenEnvVar, resolveCodexBin, spillImages } from "./codex-executor.ts";
import { CodexAppEvents } from "./codex-app-events.ts";
import { CodexRetryTracker } from "./codex-retry.ts";

type Json = Record<string, any>;
class RpcError extends Error { constructor(message: string, readonly code?: number) { super(message); } }

export function buildAppServerArgs(opts: ExecOptions): string[] {
  return ["app-server", "--listen", "stdio://", ...buildConfigOverrides(opts).flatMap(c => ["--config", c]),
    "--config", `sandbox_mode=${JSON.stringify(mapSandbox(opts.mode))}`];
}

export function appThreadParams(opts: ExecOptions): Json {
  return { cwd: opts.cwd, ...(opts.model ? { model: opts.model } : {}), sandbox: mapSandbox(opts.mode),
    approvalPolicy: opts.mode === "auto" ? "on-request" : "never",
    approvalsReviewer: opts.mode === "auto" ? "auto_review" : "user", serviceTier: "default" };
}

export function assertThreadPolicy(result: Json, opts: ExecOptions): void {
  // Treat conflicting effective settings as failure, never silently relax the
  // per-process policies because the native server/managed config changed.
  const sandbox = String(result.sandbox?.type ?? "").replace(/[-_]/g, "").toLowerCase();
  if (sandbox && opts.mode === "plan" && sandbox !== "readonly" ||
      sandbox === "dangerfullaccess" && opts.mode !== "bypassPermissions") throw new RpcError("Codex sandbox policy differs from requested mode");
  if (result.serviceTier && /^(fast|priority|ultrafast)$/i.test(result.serviceTier)) throw new RpcError("Codex unexpectedly enabled Fast service tier");
  const expected = opts.mode === "auto" ? "on-request" : "never";
  if (result.approvalPolicy && result.approvalPolicy !== expected) throw new RpcError("Codex approval policy differs from requested mode");
  if (opts.mode === "auto" && result.approvalsReviewer && !["auto_review", "guardian_subagent"].includes(result.approvalsReviewer)) throw new RpcError("Codex Auto-review is unavailable");
}

export const codexAppServerExecutor: Executor = {
  id: "codex",
  describe: () => codexExecutor.describe(),
  async *exec(opts): AsyncGenerator<ExecFrame> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-codex-app-"));
    let imagePaths: string[];
    try { imagePaths = await spillImages(opts.images, dir); }
    catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      yield { kind: "ended", result: { status: "failed", failureKind: "permanent", error: String(error) } };
      return;
    }
    const child = spawn(resolveCodexBin(), buildAppServerArgs(opts), {
      cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...Object.fromEntries((opts.mcpServers ?? []).filter(s => s.bearerToken)
        .map(s => [mcpTokenEnvVar(s.name), s.bearerToken!])), ...opts.extraEnv },
    });
    const lines = createInterface({ input: child.stdout });
    const queue: ExecFrame[] = [];
    const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; onResult?: (value: Json) => void }>();
    let wake: (() => void) | undefined, requestId = 0, closed = false, finished = false, pendingSteers = 0;
    let aborted = opts.signal.aborted, timedOut = false, threadId: string | undefined, turnId: string | undefined;
    let terminal: ExecResult | undefined, stderr = "";
    const noticeScope = randomUUID(); let noticeCount = 0, lineBytes = 0, oversized = false;
    let killTimer: NodeJS.Timeout | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    const push = (payload: Json) => { queue.push({ kind: "raw", payload }); notify(); };
    const retries = new CodexRetryTracker(push);
    const revoke = () => { turnId = undefined; opts.onSteer?.(null); };
    const failPending = (error: Error) => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
      pending.clear();
    };
    const finish = (result: ExecResult) => {
      if (finished) return;
      finished = true; terminal = result; retries.end(); revoke(); notify();
    };
    const write = (frame: Json) => {
      if (closed || child.stdin.destroyed || !child.stdin.writable) throw new RpcError("Codex connection closed");
      child.stdin.write(JSON.stringify(frame) + "\n");
    };
    const request = (method: string, params: Json, timeoutMs = 90_000, onResult?: (value: Json) => void): Promise<Json> => new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { pending.delete(id); reject(new RpcError(`Codex ${method} timed out`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, onResult });
      try { write({ id, method, params }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    const events = new CodexAppEvents(push);
    const expose = () => {
      if (!threadId || !turnId || aborted || timedOut || finished) return;
      opts.onSteer?.(async (text, messageId) => {
        const expectedTurnId = turnId;
        if (!expectedTurnId || aborted || timedOut || finished) return false;
        pendingSteers++;
        try {
          const result = await request("turn/steer", { threadId, expectedTurnId,
            input: [{ type: "text", text }], ...(messageId ? { clientUserMessageId: messageId } : {}) }, 10_000, value => {
              if (messageId && value.turnId === expectedTurnId) {
                const accepted = opts.onSteerAccepted?.(messageId);
                if (accepted) push(accepted);
              }
            });
          if (result.turnId !== expectedTurnId) throw new RpcError("Codex returned an unexpected steering acknowledgement");
          return true;
        } catch (error) {
          // A completed/replaced native turn is a normal fallback. A broken
          // transport/timeout is NOT proof that input wasn't accepted.
          if (error instanceof RpcError && (error.code === -32601 || /no active turn|not.*in.progress|turn.*mismatch|expected.*turn|turn.*not.*active/i.test(error.message))) return false;
          throw error;
        } finally {
          pendingSteers--; notify();
        }
      });
    };
    lines.on("line", line => {
      if (oversized) return;
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) {
        failPending(new RpcError("Codex protocol frame too large"));
        finish({ status: "failed", failureKind: "permanent", error: "Codex protocol frame too large" });
        child.kill("SIGTERM"); return;
      }
      let frame: Json;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame.id !== undefined && !frame.method) {
        const p = pending.get(frame.id);
        if (!p) return;
        clearTimeout(p.timer); pending.delete(frame.id);
        if (frame.error) p.reject(new RpcError(frame.error.message ?? "Codex request rejected", frame.error.code));
        else {
          try { p.onResult?.(frame.result ?? {}); p.resolve(frame.result ?? {}); }
          catch (error) { p.reject(error instanceof Error ? error : new RpcError("Codex acknowledgement failed")); }
        }
        return;
      }
      if (frame.id !== undefined && frame.method) {
        // Preserve Auto-review inside the CLI, never blanket-approve an
        // unexpected host approval or unknown server request.
        try {
          if (frame.method === "item/commandExecution/requestApproval" || frame.method === "item/fileChange/requestApproval") write({ id: frame.id, result: { decision: "decline" } });
          else if (frame.method === "item/permissions/requestApproval") write({ id: frame.id, result: { permissions: {}, scope: "turn" } });
          else write({ id: frame.id, error: { code: -32601, message: "This WebUI does not support this server request" } });
        } catch { /* process termination rejects pending requests */ }
        return;
      }
      const p = frame.params ?? {};
      if (p.threadId && threadId && p.threadId !== threadId) return;
      if (frame.method === "turn/started") {
        if (!p.turn?.id || finished) return;
        turnId = p.turn.id; expose(); push({ type: "turn.started", turn_id: turnId });
      } else if (frame.method === "turn/completed") {
        if (turnId && p.turn?.id !== turnId) return;
        const status = p.turn?.status;
        if (status === "completed") {
          push({ type: "turn.completed" }); finish({ status: "completed", failureKind: "none" });
        } else if (status === "interrupted" || aborted) finish({ status: "aborted", failureKind: "none", error: "cancelled" });
        else {
          const error = p.turn?.error?.message ?? "Codex turn failed";
          push({ type: "turn.failed", error: { message: error } });
          finish({ status: "failed", failureKind: classifyCodexError(error), error });
        }
      } else if (frame.method === "error") {
        retries.accept(frame.method, p, turnId);
        if (!p.willRetry) push({ type: "error", message: p.error?.message ?? "Codex error" });
      } else if (["warning", "guardianWarning", "configWarning", "deprecationNotice"].includes(frame.method)) {
        const message = p.summary ?? p.message ?? p.description;
        if (typeof message === "string") push({ type: "item.completed", turn_id: noticeScope,
          item: { id: `notice-${++noticeCount}`, type: "error", notice: true, message: message + (p.details ? `\n${p.details}` : "") } });
      } else if (typeof frame.method === "string" && frame.method.startsWith("item/") && !finished) {
        retries.accept(frame.method, p, turnId);
        events.accept(frame.method, p);
      }
    });
    // Enforce the line bound before readline accumulates a huge/no-newline
    // tool result, not only after JSON parsing has already allocated it.
    child.stdout.prependListener("data", (chunk: Buffer) => {
      let from = 0, newline: number;
      do {
        newline = chunk.indexOf(10, from);
        lineBytes += (newline < 0 ? chunk.length : newline) - from;
        if (lineBytes > 16 * 1024 * 1024) {
          oversized = true; lines.close(); failPending(new RpcError("Codex protocol frame too large"));
          finish({ status: "failed", failureKind: "permanent", error: "Codex protocol frame too large" });
          child.kill("SIGTERM"); return;
        }
        if (newline >= 0) lineBytes = 0;
        from = newline + 1;
      } while (newline >= 0 && from < chunk.length);
    });
    child.stderr.on("data", b => { stderr = (stderr + String(b)).slice(-8192); });
    child.on("error", error => {
      failPending(error); finish({ status: "failed", failureKind: "permanent", error: error.message });
    });
    child.stdin.on("error", error => {
      failPending(error);
      if (!finished) finish({ status: "failed", failureKind: "transient", error: "Codex input connection closed" });
    });
    child.on("close", () => {
      closed = true; failPending(new RpcError("Codex connection closed"));
      if (!finished) finish(aborted || timedOut
        ? { status: timedOut ? "timeout" : "aborted", failureKind: timedOut ? "transient" : "none" }
        : { status: "failed", failureKind: "transient", error: stderr.trim() || "Codex app-server exited before turn completed" });
    });
    const stop = () => {
      aborted = true;
      const active = turnId; revoke();
      if (threadId && active && !finished) void request("turn/interrupt", { threadId, turnId: active }, 2000).catch(() => {});
      else child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGTERM"), 2000);
    };
    opts.signal.addEventListener("abort", stop, { once: true });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs) : undefined;
    if (aborted) stop();
    // Do not await startup before yielding queued frames: thread identity and
    // native events must reach SSE while turn/start/steer RPCs are pending.
    const startup = (async () => {
      await request("initialize", { clientInfo: { name: "cc-webui", title: "cc-webui", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      write({ method: "initialized", params: {} });
      const params = appThreadParams(opts);
      // We load display history separately and never consume thread.turns.
      // Omit full-history response hydration, NOT the model's resumed context.
      const result = await request(opts.resume ? "thread/resume" : "thread/start", opts.resume
        ? { ...params, threadId: opts.resume, excludeTurns: true }
        : { ...params, allowProviderModelFallback: false });
      assertThreadPolicy(result, opts);
      if (typeof result.thread?.id !== "string" || !result.thread.id) throw new RpcError("Codex returned no thread ID");
      if (opts.resume && result.thread.id !== opts.resume) throw new RpcError("Codex resumed a different thread");
      threadId = result.thread.id;
      push({ type: "thread.started", thread_id: threadId });
      if (aborted) { stop(); return; }
      const started = await request("turn/start", { threadId, input: [{ type: "text", text: opts.prompt },
        ...imagePaths.map(p => ({ type: "localImage", path: p }))], effort: mapEffort(opts.effort),
        approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, serviceTier: "default" });
      if (!finished) {
        if (typeof started.turn?.id !== "string") throw new RpcError("Codex returned no turn ID");
        turnId = started.turn.id; expose();
      }
    })().catch(error => {
      if (!finished) finish({ status: aborted ? "aborted" : "failed", failureKind: aborted ? "none" : classifyCodexError(error.message),
        error: error.message, sessionNotFound: !!opts.resume && isThreadNotFound(error.message) });
    });
    try {
      // Completion/interrupt can precede a steer response. Drain that native
      // ACK before the terminal frame/DB save instead of killing its pipe.
      while (!finished || queue.length || pendingSteers) {
        while (queue.length) yield queue.shift()!;
        if (!finished || pendingSteers) await new Promise<void>(resolve => { wake = resolve; });
      }
      yield { kind: "ended", result: { ...terminal!,
        ...(timedOut ? { status: "timeout" as const, failureKind: "transient" as const } : {}),
        sessionHandle: terminal?.sessionNotFound ? undefined : threadId ?? opts.resume } };
    } finally {
      revoke(); if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      opts.signal.removeEventListener("abort", stop);
      failPending(new RpcError("Codex turn connection closed"));
      lines.close(); child.stdin.end();
      if (!closed) child.kill("SIGTERM");
      // Native turn completion does not terminate app-server on its own.
      if (!closed) await new Promise<void>(resolve => {
        const force = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
        child.once("close", () => { clearTimeout(force); resolve(); });
      });
      await startup; await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
