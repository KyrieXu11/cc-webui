#!/usr/bin/env -S npx tsx
// Stdio MCP server that exposes Claude (via @anthropic-ai/claude-agent-sdk) as
// a subagent for any MCP-aware host — primarily Codex CLI. Spawned on demand
// by the host (no long-running process). Communicates over stdin/stdout
// JSON-RPC. Independent of the cc-webui web server: only shares the repo's
// node_modules for dependencies.
//
// Wire it into Codex by adding to ~/.codex/config.toml:
//
//   [mcp_servers.subagent]
//   command = "npx"
//   args    = ["tsx", "/Users/xuqiang/code/cc-webui/cli/subagent-mcp/index.ts"]
//   default_tools_approval_mode = "approve"
//
// Auth: the Claude SDK spawns the `claude` binary, which uses ~/.claude/
// credentials (Claude Code's OAuth login). No env vars needed if you've run
// `claude login` once.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const DEFAULT_MODEL = "claude-opus-4-7";
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
        .enum(["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"])
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

    const response = query({
      prompt: args.prompt,
      options: {
        cwd,
        model,
        permissionMode,
        allowedTools: args.allowed_tools,
        systemPrompt: { type: "preset", preset: "claude_code" },
        // Subagent runs autonomously — no UI to ask. Auto-allow every tool;
        // the parent host (Codex) is responsible for high-level approval.
        canUseTool: async (_toolName, input) => ({
          behavior: "allow",
          updatedInput: input,
        }),
      },
    });

    let finalText = "";
    let toolUses = 0;
    const trace: string[] = [];

    try {
      for await (const msg of response as AsyncIterable<unknown>) {
        if (extra.signal?.aborted) {
          await (response as { return?: () => Promise<unknown> }).return?.();
          break;
        }
        const m = msg as {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
        };
        if (m.type === "assistant" && m.message?.content) {
          for (const block of m.message.content) {
            if (block.type === "text" && block.text) {
              finalText = block.text;
            }
            if (block.type === "tool_use") {
              toolUses++;
              const argSummary = JSON.stringify(block.input ?? {}).slice(0, 80);
              trace.push(`${block.name ?? "?"}(${argSummary})`);
              if (args.max_turns && toolUses >= args.max_turns) {
                await (response as { return?: () => Promise<unknown> }).return?.();
                break;
              }
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Claude subagent failed: ${message}` }],
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
