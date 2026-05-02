import { Codex } from "@openai/codex-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  createCodexMcpConfig,
  createCodexMcpEnv,
  getCodexMcpUrl,
} from "../codex-mcp-config.ts";
import {
  registerCodexMcpContext,
  updateCodexMcpSession,
  unregisterCodexMcpContext,
} from "../codex-mcp-context.ts";
import { systemPromptFor } from "./input-builder.ts";
import type { GroupConfig, Participant } from "./config.ts";
import type { ImageAttachment } from "./store.ts";
import type { RunnerEvent, RunnerCtx } from "./runner-types.ts";

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
  registerCodexMcpContext({
    token: mcpToken,
    sessionId: scope,
    cwd: config.cwd,
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-group-codex-"));
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await fs.rm(tmpDir, { recursive: true, force: true });
    unregisterCodexMcpContext(mcpToken);
  };

  let finalText = "";
  let finalThinking = "";

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
      config: createCodexMcpConfig(getCodexMcpUrl()),
      env: createCodexMcpEnv(mcpToken),
    });

    const { sandboxMode, approvalPolicy } = mapMode(participant.mode);
    const thread = codex.startThread({
      model: participant.model,
      workingDirectory: config.cwd,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      modelReasoningEffort: mapEffort(participant.effort),
    } as any);

    const { events } = await thread.runStreamed(input as any, {
      signal: ctx.signal,
    });

    for await (const ev of events) {
      const anyEv = ev as any;

      // Re-key MCP context to the real thread id once Codex emits it.
      if (anyEv.type === "thread.started" && anyEv.thread_id) {
        updateCodexMcpSession(mcpToken, anyEv.thread_id);
      }

      yield { kind: "raw", payload: ev };

      // Accumulate final text + thinking from completed items. For Codex
      // there's typically a single agent_message item per turn.
      if (anyEv.type === "item.completed" && anyEv.item) {
        const it = anyEv.item;
        if (it.type === "agent_message" && typeof it.text === "string") {
          finalText = it.text;
        }
        if (it.type === "reasoning" && typeof it.text === "string") {
          finalThinking += (finalThinking ? "\n\n" : "") + it.text;
        }
      }

      if (anyEv.type === "turn.completed" || anyEv.type === "turn.failed") {
        if (anyEv.type === "turn.failed") {
          const errMsg = anyEv.error?.message ?? "turn failed";
          yield {
            kind: "ended",
            ok: false,
            error: errMsg,
            finalText,
            finalThinking,
          };
          return;
        }
        break;
      }
    }

    yield { kind: "ended", ok: true, finalText, finalThinking };
  } catch (err: unknown) {
    const aborted = ctx.signal.aborted;
    yield {
      kind: "ended",
      ok: !aborted,
      error: aborted ? "aborted" : String((err as Error)?.message ?? err),
      finalText,
      finalThinking,
    };
  } finally {
    await cleanup();
  }
}
