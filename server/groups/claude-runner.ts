import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { awaitPermission } from "../permission.ts";
import { createBashMcpServer } from "../bash-mcp.ts";
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
  prompt: string;
  images: ImageAttachment[];
  ctx: RunnerCtx;
}): AsyncIterable<RunnerEvent> {
  const { config, participant, prompt, images, ctx } = args;
  const scope = `${ctx.gid}:${ctx.agentId}`;
  const allowance = getOrCreateAllowance(scope);
  const inputAllowance = getOrCreateInputAllowance(scope);

  const bashMcp = createBashMcpServer({ getSessionId: () => scope });

  // Compose prompt input for SDK. For v1 we use string form (concat-as-prompt
  // — see spike / spec). Images go via the `prompt` AsyncIterable form when
  // present (Claude SDK supports image content blocks via SDKUserMessage).
  const queryPrompt = images.length
    ? makeImagePrompt(prompt, images)
    : prompt;

  const groupSystemPrompt = systemPromptFor({ config, target: ctx.agentId });
  const systemPromptAppend = `${SYSTEM_PROMPT_APPEND_BASH}\n\n${groupSystemPrompt}`;

  let finalText = "";
  let finalThinking = "";

  try {
    const response = query({
      prompt: queryPrompt as any,
      options: {
        cwd: config.cwd,
        model: participant.model,
        permissionMode: participant.mode ?? "default",
        effort: participant.effort,
        includePartialMessages: true,
        mcpServers: { bash: bashMcp },
        disallowedTools: ["Bash", "BashOutput", "KillBash"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPromptAppend,
        },
        canUseTool: async (toolName, input, permOpts) => {
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
            permOpts.suggestions,
          );
          const id = randomUUID();
          const displayTool =
            toolName === MCP_BASH_RUN ? "Bash" : toolName;
          ctx.emitPermission({
            type: "permission_request",
            id,
            tool: displayTool,
            input,
            title: permOpts.title,
            displayName: permOpts.displayName,
            description: permOpts.description,
            hasSessionPermissionSuggestions:
              permissionSuggestions.length > 0,
            toolUseId: permOpts.toolUseID,
          });
          const decision = await awaitPermission(id, permOpts.signal);
          if (decision.behavior === "allow") {
            return { behavior: "allow", updatedInput: input };
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
      },
    });

    // Wire abort so .return() drains the SDK iterator on signal abort.
    const abortHandler = () => {
      void (response as any).return?.().catch(() => {});
    };
    if (ctx.signal.aborted) abortHandler();
    else ctx.signal.addEventListener("abort", abortHandler, { once: true });

    for await (const msg of response) {
      yield { kind: "raw", payload: msg };

      const m = msg as any;
      if (m.type === "assistant" && m.message?.content) {
        // Terminal assistant message — accumulate both text and thinking
        // blocks. (Multiple assistant messages may appear during a turn
        // for tool-use round trips; we keep the last one's blocks.)
        const blocks = m.message.content;
        if (Array.isArray(blocks)) {
          let text = "";
          let thinking = "";
          for (const b of blocks) {
            if (b?.type === "text" && typeof b.text === "string") text += b.text;
            if (b?.type === "thinking" && typeof b.thinking === "string") {
              thinking += b.thinking;
            }
          }
          if (text) finalText = text;
          if (thinking) finalThinking = thinking;
        }
      }
      if (m.type === "result") {
        // The result message carries the canonical final string. Trust it
        // over the assistant-message accumulation.
        if (typeof m.result === "string" && m.result) finalText = m.result;
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
  }
}

async function* makeImagePrompt(
  text: string,
  images: ImageAttachment[],
): AsyncIterable<unknown> {
  const content: any[] = [{ type: "text", text }];
  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }
  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}
