import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  DEFAULT_MEMBER_LIMIT,
  MAX_MEMBER_LIMIT,
  buildMentionInfos,
  fetchChatMembers,
  knownMentionTargetSummary,
  listMentionTargets,
} from "./feishu/mentions.ts";
import {
  extractBearerToken,
  getCodexMcpContext,
} from "./codex-mcp-context.ts";
import {
  MAX_TIMEOUT_MS,
  killBackground,
  listBackgroundTasksForTool,
  readBackgroundOutput,
  runBashTool,
} from "./bash-mcp.ts";

const route = new Hono();
const MAX_LARK_FILE_BYTES = 30 * 1024 * 1024;

function createServerForToken(token: string): McpServer {
  const server = new McpServer({
    name: "cc-webui-bash",
    version: "0.1.0",
  });

  const getContext = () => getCodexMcpContext(token);

  server.registerTool(
    "run",
    {
      title: "Run Bash",
      description:
        "Execute a bash command in the project working directory. " +
        "Set run_in_background=true for long-running commands; the returned bashTaskId can be polled with output or killed with kill.",
      inputSchema: {
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
          .describe("Short description of what this command does"),
        run_in_background: z
          .boolean()
          .optional()
          .describe("If true, run asynchronously and return a bashTaskId."),
      },
    },
    async (args, extra) => {
      const ctx = getContext();
      if (!ctx) {
        return {
          content: [{ type: "text", text: "MCP context expired." }],
          isError: true,
        };
      }
      return runBashTool(
        args,
        {
          cwd: ctx.cwd,
          getSessionId: () => ctx.sessionId,
        },
        extra.signal
      );
    }
  );

  server.registerTool(
    "output",
    {
      title: "Read Bash Output",
      description:
        "Retrieve new stdout/stderr output from a background bash task since the last poll, plus current status and exit code.",
      inputSchema: {
        bash_id: z
          .string()
          .describe("The bashTaskId returned by run with run_in_background=true"),
      },
    },
    async ({ bash_id }) => readBackgroundOutput(bash_id)
  );

  server.registerTool(
    "kill",
    {
      title: "Kill Bash Task",
      description: "Kill a running background bash task by bashTaskId.",
      inputSchema: {
        bash_id: z
          .string()
          .describe("The bashTaskId returned by run with run_in_background=true"),
      },
    },
    async ({ bash_id }) => killBackground(bash_id)
  );

  server.registerTool(
    "list",
    {
      title: "List Bash Tasks",
      description:
        "List background bash tasks for this conversation, including id, status and command.",
      inputSchema: {},
    },
    async () => {
      const ctx = getContext();
      if (!ctx) {
        return {
          content: [{ type: "text", text: "MCP context expired." }],
          isError: true,
        };
      }
      return listBackgroundTasksForTool(ctx.sessionId);
    }
  );

  return server;
}

function createLarkServerForToken(token: string): McpServer {
  const server = new McpServer({
    name: "cc-webui-lark",
    version: "0.1.0",
  });

  const getLarkContext = () => getCodexMcpContext(token)?.lark;

  server.registerTool(
    "send_file",
    {
      title: "Send Feishu File",
      description:
        "Upload a local file and post it to a Feishu chat under the bot's identity. " +
        "Use absolute paths. chat_id defaults to the chat that initiated the current turn.",
      inputSchema: {
        file_path: z
          .string()
          .describe("Absolute path to the local file to send"),
        chat_id: z
          .string()
          .optional()
          .describe("Feishu chat_id (oc_xxx). Defaults to the current chat."),
      },
    },
    async ({ file_path, chat_id }) => {
      const ctx = getLarkContext();
      if (!ctx) return mcpError("Lark MCP context expired.");
      try {
        const abs = path.resolve(file_path);
        const buf = await fs.readFile(abs);
        if (buf.length > MAX_LARK_FILE_BYTES) {
          return mcpError(
            `file too large: ${buf.length} bytes (max ${MAX_LARK_FILE_BYTES})`,
          );
        }
        const fileName = path.basename(abs);
        const targetChatId = chat_id ?? ctx.defaultChatId;
        const res = await ctx.channel.send(targetChatId, {
          file: { source: buf, fileName },
        });
        return mcpText(
          `sent: ${fileName} → ${targetChatId} (message_id=${res.messageId})`,
        );
      } catch (err) {
        return mcpError(errMsg(err));
      }
    },
  );

  server.registerTool(
    "send_image",
    {
      title: "Send Feishu Image",
      description:
        "Upload a local image (png/jpeg/gif/webp) and post it to a Feishu chat. " +
        "Use absolute paths. chat_id defaults to the current chat.",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the local image file"),
        chat_id: z
          .string()
          .optional()
          .describe("Feishu chat_id. Defaults to the current chat."),
      },
    },
    async ({ file_path, chat_id }) => {
      const ctx = getLarkContext();
      if (!ctx) return mcpError("Lark MCP context expired.");
      try {
        const abs = path.resolve(file_path);
        const buf = await fs.readFile(abs);
        if (buf.length > MAX_LARK_FILE_BYTES) {
          return mcpError(`image too large: ${buf.length} bytes`);
        }
        const targetChatId = chat_id ?? ctx.defaultChatId;
        const res = await ctx.channel.send(targetChatId, {
          image: { source: buf },
        });
        return mcpText(
          `sent image: ${path.basename(abs)} → ${targetChatId} (message_id=${res.messageId})`,
        );
      } catch (err) {
        return mcpError(errMsg(err));
      }
    },
  );

  server.registerTool(
    "send_text",
    {
      title: "Send Feishu Text",
      description:
        "Send a plain-text message to a Feishu chat, optionally with real Feishu @ mentions. " +
        "Use mention_open_ids from list_chat_members, or mention_targets aliases/open_ids. " +
        `${knownMentionTargetSummary()} chat_id defaults to the current chat.`,
      inputSchema: {
        text: z.string().describe("Text content to send"),
        chat_id: z
          .string()
          .optional()
          .describe("Feishu chat_id. Defaults to the current chat."),
        mention_open_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Feishu user/bot open_id values to @. For people, call list_chat_members first.",
          ),
        mention_targets: z
          .array(z.string())
          .optional()
          .describe(
            "Named targets from list_mention_targets (for example codex-bot/claude-bot) or raw open_id values.",
          ),
      },
    },
    async ({ text, chat_id, mention_open_ids, mention_targets }) => {
      const ctx = getLarkContext();
      if (!ctx) return mcpError("Lark MCP context expired.");
      try {
        const targetChatId = chat_id ?? ctx.defaultChatId;
        const mentionResult = buildMentionInfos(mention_targets, mention_open_ids);
        if (mentionResult.error) return mcpError(mentionResult.error);
        const res = await ctx.channel.send(
          targetChatId,
          { text },
          mentionResult.mentions.length > 0
            ? { mentions: mentionResult.mentions }
            : undefined,
        );
        return mcpText(
          `sent text → ${targetChatId} (message_id=${res.messageId}${mentionResult.resolved.length > 0 ? `, mentioned=${mentionResult.resolved.map((m) => m.name ?? m.alias).join(", ")}` : ""})`,
        );
      } catch (err) {
        return mcpError(errMsg(err));
      }
    },
  );

  server.registerTool(
    "list_chat_members",
    {
      title: "List Feishu Chat Members",
      description:
        "List human members of a Feishu group and return their open_id values for @ mentions. " +
        "Feishu's chat-members API does not return bot members; use list_mention_targets for known bots.",
      inputSchema: {
        chat_id: z
          .string()
          .optional()
          .describe("Feishu chat_id. Defaults to the current chat."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_MEMBER_LIMIT)
          .optional()
          .describe(`Maximum members to return. Defaults to ${DEFAULT_MEMBER_LIMIT}.`),
      },
    },
    async ({ chat_id, limit }) => {
      const ctx = getLarkContext();
      if (!ctx) return mcpError("Lark MCP context expired.");
      try {
        const targetChatId = chat_id ?? ctx.defaultChatId;
        const members = await fetchChatMembers(ctx.channel, targetChatId, limit);
        return mcpText(
          JSON.stringify(
            {
              chat_id: targetChatId,
              member_id_type: "open_id",
              note:
                "Feishu does not return bot members from this API; call list_mention_targets for known bots.",
              members,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return mcpError(errMsg(err));
      }
    },
  );

  server.registerTool(
    "list_mention_targets",
    {
      title: "List Feishu Mention Targets",
      description:
        "List configured/built-in mention target aliases that send_text can @ without scanning the current message. " +
        "Loaded Feishu bots are registered here, so Claude/Codex can proactively mention each other.",
      inputSchema: {},
    },
    async () =>
      mcpText(
        JSON.stringify(
          {
            targets: listMentionTargets(),
            usage:
              "Pass one or more target.alias values as send_text({ mention_targets: [...] }).",
          },
          null,
          2,
        ),
      ),
  );

  return server;
}

function mcpText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function mcpError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

route.all("/bash", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!getCodexMcpContext(token)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createServerForToken(token!);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

route.all("/lark", async (c) => {
  const token = extractBearerToken(c.req.header("authorization"));
  const ctx = getCodexMcpContext(token);
  if (!ctx) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!ctx.lark) {
    return c.json({ error: "lark context unavailable" }, 403);
  }

  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createLarkServerForToken(token!);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export { route as mcpBashRoute };
