#!/usr/bin/env -S npx tsx
// Stdio MCP server that exposes Claude as a subagent for any MCP-aware host —
// primarily Codex CLI. Spawned on demand by the host (no long-running process).
// Communicates over stdin/stdout JSON-RPC.
//
// Drives the `claude` CLI through the shared executor in server/executors/,
// which is the repo's single copy of that logic (see docs/cli-migration.md,
// decision #5: no separate package). That is the only thing this tool borrows
// from the web server — it starts no HTTP listener and reads none of its state.
//
// Wire it into Codex by adding to ~/.codex/config.toml:
//
//   [mcp_servers.subagent]
//   command = "npx"
//   args    = ["tsx", "/Users/xuqiang/code/cc-webui/cli/subagent-mcp/index.ts"]
//   default_tools_approval_mode = "approve"
//
// Auth: the executor spawns the `claude` binary, which uses ~/.claude/
// credentials (Claude Code's OAuth login). No env vars needed if you've run
// `claude login` once. Set CC_WEBUI_CLAUDE_BIN to pin a specific binary.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { claudeExecutor } from "../../server/executors/claude-executor.ts";
import { z } from "zod";

const DEFAULT_MODEL = "opus";
const DEFAULT_PERMISSION_MODE = "acceptEdits";

const server = new McpServer({
  name: "claude-subagent",
  version: "0.1.0",
});

server.registerTool(
  "claude",
  {
    title: "Claude subagent",
    description:
      "Delegate a focused subtask to Claude (Code SDK). Claude runs its own " +
      "agent loop with Read/Edit/Bash/Grep/Glob in `cwd`. Returns the final " +
      "assistant text plus a short trace of the tool calls Claude made. " +
      "Use for hard reasoning, careful reviews, large refactors — anywhere " +
      "you want a second pair of eyes from a different model family.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe("Self-contained task for Claude. Be specific and complete — Claude has no other context from the parent agent."),
      cwd: z
        .string()
        .optional()
        .describe("Working directory for Claude. Defaults to the host's cwd (where Codex was launched)."),
      model: z
        .enum(["opus", "fable", "sonnet", "haiku"])
        .optional()
        .describe(`Default: ${DEFAULT_MODEL}.`),
      permission_mode: z
        .enum(["plan", "default", "acceptEdits", "bypassPermissions"])
        .optional()
        .describe(`Default: ${DEFAULT_PERMISSION_MODE}. Use 'plan' for read-only review, 'bypassPermissions' for fully autonomous destructive work.`),
      allowed_tools: z
        .array(z.string())
        .optional()
        .describe("If set, restrict Claude to these tool names (e.g. ['Read', 'Grep', 'Glob'] for an explore-only subagent)."),
      max_turns: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Cap the number of tool-use iterations Claude runs. Default: unlimited (within Claude SDK's own limits)."),
    },
  },
  async (args, extra) => {
    const cwd = args.cwd ?? process.cwd();
    const model = args.model ?? DEFAULT_MODEL;
    const permissionMode = args.permission_mode ?? DEFAULT_PERMISSION_MODE;

    // The host may cancel mid-run; the executor takes the signal directly, so
    // no iterator-.return() dance is needed.
    const abort = new AbortController();
    const onHostAbort = () => abort.abort();
    extra.signal?.addEventListener("abort", onHostAbort, { once: true });
    if (extra.signal?.aborted) abort.abort();

    const frames = claudeExecutor.exec({
      prompt: args.prompt,
      cwd,
      signal: abort.signal,
      model,
      mode: permissionMode,
      allowedTools: args.allowed_tools,
      // Subagent runs autonomously — no UI to ask. Auto-allow every tool; the
      // parent host (Codex) is responsible for high-level approval. Supplying a
      // handler at all is what puts the CLI on the stdio permission protocol,
      // so tool use is never silently refused.
      onPermissionAsk: async ({ input }) => ({
        behavior: "allow" as const,
        updatedInput: input,
      }),
    });

    let finalText = "";
    let toolUses = 0;
    const trace: string[] = [];
    let failure: string | undefined;

    try {
      for await (const frame of frames) {
        if (frame.kind === "ended") {
          const r = frame.result;
          // A cancel or a max_turns break is not a failure worth reporting as
          // an error — whatever text Claude produced so far still stands.
          if (r.status !== "completed" && r.status !== "aborted") {
            failure = r.error ?? r.status;
          }
          break;
        }
        const m = frame.payload as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
        };
        if (m.type === "assistant" && m.message?.content) {
          let stop = false;
          for (const block of m.message.content) {
            if (block.type === "text" && block.text) {
              finalText = block.text;
            }
            if (block.type === "tool_use") {
              toolUses++;
              const argSummary = JSON.stringify(block.input ?? {}).slice(0, 80);
              trace.push(`${block.name ?? "?"}(${argSummary})`);
              if (args.max_turns && toolUses >= args.max_turns) {
                stop = true;
                break;
              }
            }
          }
          // Leaving the loop runs the generator's cleanup, which kills the CLI.
          if (stop) break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Claude subagent failed: ${message}` }],
        isError: true,
      };
    } finally {
      extra.signal?.removeEventListener("abort", onHostAbort);
    }

    if (failure) {
      return {
        content: [{ type: "text", text: `Claude subagent failed: ${failure}` }],
        isError: true,
      };
    }

    const summary = trace.length
      ? `\n\n--- subagent steps (${trace.length}) ---\n${trace.join("\n")}`
      : "";
    const text = (finalText || "(claude returned no text)") + summary;

    return {
      content: [{ type: "text", text }],
      isError: false,
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
