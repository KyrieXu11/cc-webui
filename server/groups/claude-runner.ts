import { randomUUID } from "node:crypto";
import { awaitPermission } from "../permission.ts";
import { ownerOf } from "../auth/ownership.ts";
import { claudeExecutor } from "../executors/claude-executor.ts";
import type { McpServerSpec } from "../executors/types.ts";
import { getMcpRouteUrl } from "../codex-mcp-config.ts";
import {
  registerMcpSessionContext,
  unregisterMcpSessionContext,
} from "../mcp-context.ts";
import {
  getOrCreateAllowance,
  getOrCreateInputAllowance,
  permissionInputKey,
  sessionPermissionSuggestions,
} from "../shared/permission-flow.ts";
import { systemPromptFor } from "./input-builder.ts";
import type { GroupConfig, Participant } from "./config.ts";
import type { ImageAttachment } from "./store.ts";
import type { RunnerEvent, RunnerCtx } from "./runner-types.ts";
import { applySDKMessage } from "../../src/lib/processor.ts";
import type { ChatEvent } from "../../src/lib/types.ts";

const MCP_BASH_RUN = "mcp__bash__run";
const MCP_BASH_OUTPUT = "mcp__bash__output";
const MCP_BASH_KILL = "mcp__bash__kill";
const MCP_BASH_LIST = "mcp__bash__list";

const SYSTEM_PROMPT_APPEND_BASH =
  "SHELL TOOLS: The built-in Bash/BashOutput/KillBash tools are DISABLED. " +
  `Use ${MCP_BASH_RUN} (same schema: command, timeout, description, plus run_in_background). ` +
  `For background tasks, list with ${MCP_BASH_LIST}, poll with ${MCP_BASH_OUTPUT} (bash_id), and terminate with ${MCP_BASH_KILL} (bash_id). ` +
  "Do not try to invoke the built-in Bash — it will be rejected.";

export async function* runClaude(args: {
  config: GroupConfig;
  participant: Participant;
  // The string to send as the user prompt for THIS turn. With resume,
  // this is just the catchup (new user msg + peer reply cross-injection).
  // Without resume, it's the full rendered history + current user msg.
  prompt: string;
  images: ImageAttachment[];
  ctx: RunnerCtx;
}): AsyncIterable<RunnerEvent> {
  const { config, participant, prompt, images, ctx } = args;
  const scope = `${ctx.gid}:${ctx.agentId}`;
  const allowance = getOrCreateAllowance(scope);
  const inputAllowance = getOrCreateInputAllowance(scope);

  // MCP over HTTP, same routes Codex and Feishu already use. A per-turn bearer
  // token carries this turn's context.
  //
  // The Feishu adapter used to inject `lark` twice — an in-process SDK server
  // for Claude and an HTTP context for Codex. Now both providers take the HTTP
  // one, so ctx.extraMcpServers is gone along with the SDK.
  const mcpToken = randomUUID();
  registerMcpSessionContext({
    token: mcpToken,
    sessionId: scope,
    ownerId: ctx.ownerId,
    // The group bash MCP never used to receive a cwd, so mcp__bash__run ran in
    // the SERVER's cwd while Claude's own file tools got config.cwd — an agent
    // reading one tree and shelling into another. Fixed here, deliberately as
    // its own change rather than inside the driver swap.
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
      // Adapter namespace: cc-webui-internal, so no card. Same policy the
      // canUseTool callback used to apply by inspecting the namespace.
      autoAllow: true,
    });
  }

  const groupSystemPrompt = systemPromptFor({ config, target: ctx.agentId });
  const systemPromptAppend = `${SYSTEM_PROMPT_APPEND_BASH}\n\n${groupSystemPrompt}`;

  let events: ChatEvent[] = [];
  let capturedSessionId: string | undefined = ctx.resumeSessionId;

  try {
    const frames = claudeExecutor.exec({
      prompt,
      images,
      cwd: config.cwd,
      signal: ctx.signal,
      model: participant.model,
      effort: participant.effort,
      mode: participant.mode ?? "default",
      ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      // ScheduleWakeup additionally disabled: group turns are driven by
      // the orchestrator's pipeline — a CLI-side wakeup would re-enter a
      // session outside the orchestrator's control.
      disallowedTools: ["Bash", "BashOutput", "KillBash", "ScheduleWakeup"],
      appendSystemPrompt: systemPromptAppend,
      mcpServers,
      // Same decision logic as the SDK-era canUseTool; only the parameter
      // shape changed.
      onPermissionAsk: async ({
        toolName,
        input,
        suggestions,
        displayName,
        description,
        title,
        toolUseId,
        signal,
      }) => {
          // Auto-allow our trusted MCP tools (mirrors single-chat behavior)
          if (
            toolName === MCP_BASH_OUTPUT ||
            toolName === MCP_BASH_KILL ||
            toolName === MCP_BASH_LIST
          ) {
            return { behavior: "allow", updatedInput: input };
          }
          if (allowance.has(toolName)) {
            return { behavior: "allow", updatedInput: input };
          }
          const inputKey = permissionInputKey(toolName, input);
          if (inputAllowance.has(inputKey)) {
            return { behavior: "allow", updatedInput: input };
          }
          const permissionSuggestions = sessionPermissionSuggestions(
            suggestions,
          );
          const id = randomUUID();
          const displayTool =
            toolName === MCP_BASH_RUN ? "Bash" : toolName;
          const permPayload = {
            type: "permission_request",
            id,
            tool: displayTool,
            input,
            title: title,
            displayName: displayName,
            description: description,
            hasSessionPermissionSuggestions:
              permissionSuggestions.length > 0,
            toolUseId: toolUseId,
          };
          // Fold into server-side events accumulator (so canonical jsonl
          // captures the card) AND emit through the raw SSE channel so
          // the client renders it via the same code path single chat
          // uses.
          events = applySDKMessage(events, permPayload, () => {});
          ctx.emitPermission(permPayload);
          let decision: Awaited<ReturnType<typeof awaitPermission>>;
          try {
            decision = await awaitPermission(id, signal, {
              ownerId: ownerOf(ctx.gid) ?? undefined,
              gid: ctx.gid,
            });
          } catch (err) {
            const resolvedPayload = {
              type: "permission_resolved",
              id,
              stale: true,
            };
            events = applySDKMessage(events, resolvedPayload, () => {});
            ctx.emitPermission(resolvedPayload);
            throw err;
          }
          const resolvedPayload = {
            type: "permission_resolved",
            id,
            behavior: decision.behavior,
          };
          ctx.emitPermission(resolvedPayload);
          // Mark the in-memory permission entry as resolved so a refresh
          // after turn_end shows the card in its post-decision state.
          events = applySDKMessage(events, resolvedPayload, () => {});
          if (decision.behavior === "allow") {
            // 同网页单聊：AskUserQuestion 的答案通过 updatedInput.answers 回传。
            return {
              behavior: "allow",
              updatedInput: decision.answers
                ? { ...input, answers: decision.answers }
                : input,
            };
          }
          if (decision.behavior === "allow_session") {
            inputAllowance.add(inputKey);
            if (permissionSuggestions.length === 0) {
              return { behavior: "allow", updatedInput: input };
            }
            return {
              behavior: "allow",
              updatedInput: input,
              updatedPermissions: permissionSuggestions,
            };
          }
          if (decision.behavior === "allow_tool_session") {
            allowance.add(toolName);
            return { behavior: "allow", updatedInput: input };
          }
          return decision;
      },
    });

    for await (const frame of frames) {
      if (frame.kind === "ended") {
        const r = frame.result;
        const sessionId = r.sessionHandle ?? capturedSessionId;
        if (r.status === "completed") {
          yield { kind: "ended", ok: true, events, sessionId };
        } else {
          yield {
            kind: "ended",
            ok: false,
            error: r.status === "aborted" ? "aborted" : (r.error ?? r.status),
            events,
            // The executor already withholds a handle it knows is dead, but be
            // explicit: the orchestrator clears + retries on this flag.
            sessionId: r.sessionNotFound ? undefined : sessionId,
            sessionNotFound: r.sessionNotFound,
          };
        }
        return;
      }
      const msg = frame.payload;
      yield { kind: "raw", payload: msg };
      // Fold via the same mapper the frontend uses, so persisted entries
      // and live UI render identically.
      events = applySDKMessage(events, msg, (id) => {
        capturedSessionId = id;
      });
      // Also pull session_id directly off any message that carries it.
      const sid = (msg as any).session_id;
      if (typeof sid === "string" && sid) capturedSessionId = sid;
    }

    // The executor always emits `ended`; reaching here means the generator was
    // torn down early (consumer stopped iterating).
    yield { kind: "ended", ok: false, error: "runner ended without result", events, sessionId: capturedSessionId };
  } catch (err: unknown) {
    const aborted = ctx.signal.aborted;
    yield {
      kind: "ended",
      // Any thrown error is a failed turn (was `!aborted`, which wrongly
      // reported genuine exceptions as ok:true and swallowed them).
      ok: false,
      error: aborted ? "aborted" : String((err as Error)?.message ?? err),
      events,
      sessionId: capturedSessionId,
    };
  } finally {
    unregisterMcpSessionContext(mcpToken);
  }
}
