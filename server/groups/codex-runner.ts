import { randomUUID } from "node:crypto";
import { getMcpRouteUrl } from "../codex-mcp-config.ts";
import {
  registerMcpSessionContext,
  updateMcpSession,
  unregisterMcpSessionContext,
} from "../mcp-context.ts";
import { codexExecutor } from "../executors/codex-executor.ts";
import type { McpServerSpec } from "../executors/types.ts";
import { systemPromptFor } from "./input-builder.ts";
import { isCodexModelMismatchNotice } from "../codex-events.ts";
import type { GroupConfig, Participant } from "./config.ts";
import type { ImageAttachment } from "./store.ts";
import type { RunnerEvent, RunnerCtx } from "./runner-types.ts";
import { applySDKMessage } from "../../src/lib/processor.ts";
import type { ChatEvent } from "../../src/lib/types.ts";

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
    ownerId: ctx.ownerId,
    cwd: config.cwd,
    lark: ctx.codexMcp?.lark,
  });

  const mcpServers: McpServerSpec[] = [
    {
      name: "bash",
      url: getMcpRouteUrl(process.env, "bash"),
      bearerToken: mcpToken,
    },
  ];
  if (ctx.codexMcp?.lark) {
    mcpServers.push({
      name: "lark",
      url: getMcpRouteUrl(process.env, "lark"),
      bearerToken: mcpToken,
      // Adapter namespace. Moot on Codex, which has no permission cards at
      // all — kept so the spec reads the same as the Claude runner's.
      autoAllow: true,
    });
  }

  let events: ChatEvent[] = [];
  let capturedThreadId: string | undefined = ctx.resumeSessionId;

  try {
    // CLI-driven (was @openai/codex-sdk). The executor owns image spilling and
    // its temp dir, so none of that bookkeeping lives here any more.
    const frames = codexExecutor.exec({
      prompt: fullPrompt,
      images,
      cwd: config.cwd,
      signal: ctx.signal,
      model: participant.model,
      effort: participant.effort,
      mode: participant.mode,
      ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      mcpServers,
    });

    for await (const frame of frames) {
      if (frame.kind === "ended") {
        const r = frame.result;
        const sessionId = r.sessionHandle ?? capturedThreadId;
        if (r.status === "completed") {
          yield { kind: "ended", ok: true, events, sessionId };
        } else {
          yield {
            kind: "ended",
            ok: false,
            error: r.status === "aborted" ? "aborted" : (r.error ?? r.status),
            events,
            // On a stale-thread resume, don't hand the dead id back for
            // persistence; the orchestrator clears it and retries fresh.
            // (The executor already withholds it — being explicit because the
            // orchestrator keys its retry off this flag.)
            sessionId: r.sessionNotFound ? undefined : sessionId,
            sessionNotFound: r.sessionNotFound,
          };
        }
        return;
      }

      const ev = frame.payload as any;

      // Drop the benign "recorded with model X but resuming with Y" advisory
      // so it never leaks into the chat card / transcript. The turn proceeds
      // under the requested model regardless.
      if (isCodexModelMismatchNotice(ev)) continue;

      // Re-key MCP context to the real thread id once Codex emits it.
      if (ev.type === "thread.started" && ev.thread_id) {
        updateMcpSession(mcpToken, ev.thread_id);
        capturedThreadId = ev.thread_id;
      }

      yield { kind: "raw", payload: ev };
      events = applySDKMessage(events, ev, () => {});
    }

    // The executor always emits `ended`; reaching here means the generator was
    // torn down early (consumer stopped iterating).
    yield {
      kind: "ended",
      ok: false,
      error: "runner ended without result",
      events,
      sessionId: capturedThreadId,
    };
  } catch (err: unknown) {
    const aborted = ctx.signal.aborted;
    yield {
      kind: "ended",
      // Any thrown error is a failed turn (was `!aborted`, which wrongly
      // marked genuine exceptions ok:true — so the orchestrator neither
      // surfaced them nor triggered the stale-thread self-heal).
      ok: false,
      error: aborted ? "aborted" : String((err as Error)?.message ?? err),
      events,
      sessionId: capturedThreadId,
    };
  } finally {
    unregisterMcpSessionContext(mcpToken);
  }
}
