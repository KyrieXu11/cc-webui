import { Codex } from "@openai/codex-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createCodexMcpConfig,
  createCodexMcpEnv,
  getMcpRouteUrl,
} from "../codex-mcp-config.ts";
import {
  registerMcpSessionContext,
  updateMcpSession,
  unregisterMcpSessionContext,
} from "../mcp-context.ts";
import { systemPromptFor } from "./input-builder.ts";
import { isCodexModelMismatchNotice } from "../codex-events.ts";
import type { GroupConfig, Participant } from "./config.ts";
import type { ImageAttachment } from "./store.ts";
import type { RunnerEvent, RunnerCtx } from "./runner-types.ts";
import { applySDKMessage } from "../../src/lib/processor.ts";
import type { ChatEvent } from "../../src/lib/types.ts";

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function mapEffort(e: string | undefined) {
  if (e === "low" || e === "medium" || e === "high") return e;
  if (e === "xhigh" || e === "max") return "xhigh";
  return "medium";
}

function mapMode(mode: string | undefined): {
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
} {
  if (mode === "plan") {
    return { sandboxMode: "read-only", approvalPolicy: "never" };
  }
  if (mode === "bypassPermissions") {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never" };
  }
  return { sandboxMode: "workspace-write", approvalPolicy: "never" };
}

// Codex surfaces resuming a thread it no longer has as an error like:
// "thread/resume: thread/resume failed: no rollout found for thread id <id>".
// Detect it so the orchestrator can drop the dead thread id and retry with
// a fresh thread + full history (mirrors the Claude "No conversation found
// with session ID" self-heal path).
function isThreadNotFound(msg: string | undefined): boolean {
  if (!msg) return false;
  return /no rollout found for thread|thread\/resume failed/i.test(msg);
}

export async function* runCodex(args: {
  config: GroupConfig;
  participant: Participant;
  prompt: string;
  images: ImageAttachment[];
  ctx: RunnerCtx;
}): AsyncIterable<RunnerEvent> {
  const { config, participant, prompt, images, ctx } = args;
  const scope = `${ctx.gid}:${ctx.agentId}`;

  // Codex doesn't accept a system prompt directly; fold the group preamble
  // into the prompt. The preamble + cross-injection prefixes give the
  // model enough context to behave as a group participant.
  const groupSystemPrompt = systemPromptFor({ config, target: ctx.agentId });
  const fullPrompt = `[系统指引]\n${groupSystemPrompt}\n\n${prompt}`;

  const mcpToken = randomUUID();
  registerMcpSessionContext({
    token: mcpToken,
    sessionId: scope,
    cwd: config.cwd,
    lark: ctx.codexMcp?.lark,
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-group-codex-"));
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await fs.rm(tmpDir, { recursive: true, force: true });
    unregisterMcpSessionContext(mcpToken);
  };

  let events: ChatEvent[] = [];
  let capturedThreadId: string | undefined = ctx.resumeSessionId;

  try {
    // Build the input array: text first, then any image attachments as
    // local_image refs after writing them to a temp dir Codex can read.
    const input: Array<
      { type: "text"; text: string } | { type: "local_image"; path: string }
    > = [{ type: "text", text: fullPrompt }];

    for (const img of images) {
      if (!img.mediaType?.startsWith("image/")) continue;
      const ext = IMAGE_EXT_BY_MIME[img.mediaType.toLowerCase()];
      if (!ext) continue;
      const buf = Buffer.from(img.data, "base64");
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) continue;
      const file = path.join(tmpDir, `${randomUUID()}${ext}`);
      await fs.writeFile(file, buf, { mode: 0o600 });
      input.push({ type: "local_image", path: file });
    }

    const codex = new Codex({
      config: createCodexMcpConfig({
        bashUrl: getMcpRouteUrl(process.env, "bash"),
        larkUrl: ctx.codexMcp?.lark
          ? getMcpRouteUrl(process.env, "lark")
          : undefined,
      }),
      env: createCodexMcpEnv(mcpToken),
    });

    const { sandboxMode, approvalPolicy } = mapMode(participant.mode);
    const threadOptions = {
      model: participant.model,
      workingDirectory: config.cwd,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      modelReasoningEffort: mapEffort(participant.effort),
    } as any;
    // Resume an existing thread if we have one; else start fresh and
    // capture the new id.
    const thread = ctx.resumeSessionId
      ? codex.resumeThread(ctx.resumeSessionId, threadOptions)
      : codex.startThread(threadOptions);

    const stream = await thread.runStreamed(input as any, {
      signal: ctx.signal,
    });

    for await (const ev of stream.events) {
      const anyEv = ev as any;

      // Drop the benign "recorded with model X but resuming with Y" advisory
      // so it never leaks into the chat card / transcript. The turn proceeds
      // under the requested model regardless.
      if (isCodexModelMismatchNotice(anyEv)) continue;

      // Re-key MCP context to the real thread id once Codex emits it.
      if (anyEv.type === "thread.started" && anyEv.thread_id) {
        updateMcpSession(mcpToken, anyEv.thread_id);
        capturedThreadId = anyEv.thread_id;
      }

      yield { kind: "raw", payload: ev };
      events = applySDKMessage(events, ev, () => {});

      if (anyEv.type === "turn.completed" || anyEv.type === "turn.failed") {
        if (anyEv.type === "turn.failed") {
          const errMsg = anyEv.error?.message ?? "turn failed";
          const notFound = isThreadNotFound(errMsg);
          yield {
            kind: "ended",
            ok: false,
            error: errMsg,
            events,
            // On a stale-thread resume, don't hand the dead id back for
            // persistence; the orchestrator clears it and retries fresh.
            sessionId: notFound ? undefined : capturedThreadId,
            sessionNotFound: notFound,
          };
          return;
        }
        break;
      }
    }

    // Fallback: thread.id can be set after a successful run even without
    // a thread.started event (e.g. on resume).
    if (!capturedThreadId && (thread as any).id) {
      capturedThreadId = (thread as any).id;
    }

    yield { kind: "ended", ok: true, events, sessionId: capturedThreadId };
  } catch (err: unknown) {
    const aborted = ctx.signal.aborted;
    const errMsg = String((err as Error)?.message ?? err);
    const notFound = !aborted && isThreadNotFound(errMsg);
    yield {
      kind: "ended",
      // Any thrown error is a failed turn (was `!aborted`, which wrongly
      // marked genuine exceptions ok:true — so the orchestrator neither
      // surfaced them nor triggered the stale-thread self-heal).
      ok: false,
      error: aborted ? "aborted" : errMsg,
      events,
      // On a stale-thread resume, drop the dead id so the orchestrator
      // retries with a fresh thread instead of re-persisting a bad id.
      sessionId: notFound ? undefined : capturedThreadId,
      sessionNotFound: notFound,
    };
  } finally {
    await cleanup();
  }
}
