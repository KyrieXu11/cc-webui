import { promises as fs } from "node:fs";
import path from "node:path";
import type * as lark from "@larksuiteoapi/node-sdk";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  DEFAULT_MEMBER_LIMIT,
  MAX_MEMBER_LIMIT,
  buildMentionInfos,
  fetchChatMembers,
  knownMentionTargetSummary,
  listMentionTargets,
} from "./mentions.ts";

// In-process MCP server that exposes Feishu IM send capabilities to Claude.
// Codex gets the same tools through the HTTP MCP route in mcp-bash-route.ts.
// Created per-turn so the LarkChannel + originating chat_id are baked in;
// tools accept an optional chat_id override (so Claude can also push files
// to other chats it knows about — e.g. via Feishu chat-id mentioned in
// the prompt) but default to the chat that initiated the turn.
//
// All sends happen with the bot's tenant_access_token (same identity that
// already replies in the chat), so the recipient sees the file as sent by
// cc-webui's bot rather than by the OAuth-logged-in user.

const MAX_FILE_BYTES = 30 * 1024 * 1024;

export function createLarkMcpServer(args: {
  channel: lark.LarkChannel;
  defaultChatId: string;
}): McpSdkServerConfigWithInstance {
  const { channel, defaultChatId } = args;

  const sendFile = tool(
    "send_file",
    "Upload a local file and post it to a Feishu chat under the bot's identity. " +
      "Use absolute paths. chat_id defaults to the chat that initiated " +
      "the current turn — only pass it if you need to send to a different chat.",
    {
      file_path: z
        .string()
        .describe("Absolute path to the local file to send"),
      chat_id: z
        .string()
        .optional()
        .describe(
          "Feishu chat_id (oc_xxx). Defaults to the current chat if omitted.",
        ),
    },
    async ({ file_path, chat_id }) => {
      try {
        const abs = path.resolve(file_path);
        const buf = await fs.readFile(abs);
        if (buf.length > MAX_FILE_BYTES) {
          return errorResult(
            `file too large: ${buf.length} bytes (max ${MAX_FILE_BYTES})`,
          );
        }
        const fileName = path.basename(abs);
        const res = await channel.send(chat_id ?? defaultChatId, {
          file: { source: buf, fileName },
        });
        return textResult(
          `sent: ${fileName} → ${chat_id ?? defaultChatId} (message_id=${res.messageId})`,
        );
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  const sendImage = tool(
    "send_image",
    "Upload a local image (png/jpeg/gif/webp) and post it to a Feishu chat. " +
      "Use absolute paths. chat_id defaults to the current chat.",
    {
      file_path: z.string().describe("Absolute path to the local image file"),
      chat_id: z
        .string()
        .optional()
        .describe("Feishu chat_id. Defaults to the current chat."),
    },
    async ({ file_path, chat_id }) => {
      try {
        const abs = path.resolve(file_path);
        const buf = await fs.readFile(abs);
        if (buf.length > MAX_FILE_BYTES) {
          return errorResult(`image too large: ${buf.length} bytes`);
        }
        const res = await channel.send(chat_id ?? defaultChatId, {
          image: { source: buf },
        });
        return textResult(
          `sent image: ${path.basename(abs)} → ${chat_id ?? defaultChatId} (message_id=${res.messageId})`,
        );
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  const sendText = tool(
    "send_text",
    "Send a plain-text message to a Feishu chat, optionally with real Feishu @ mentions. " +
      "Use mention_open_ids from list_chat_members, or mention_targets aliases/open_ids. " +
      `${knownMentionTargetSummary()} chat_id defaults to the current chat.`,
    {
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
    async ({ text, chat_id, mention_open_ids, mention_targets }) => {
      try {
        const mentionResult = buildMentionInfos(mention_targets, mention_open_ids);
        if (mentionResult.error) return errorResult(mentionResult.error);
        const targetChatId = chat_id ?? defaultChatId;
        const res = await channel.send(
          targetChatId,
          { text },
          mentionResult.mentions.length > 0
            ? { mentions: mentionResult.mentions }
            : undefined,
        );
        return textResult(
          `sent text → ${targetChatId} (message_id=${res.messageId}${mentionResult.resolved.length > 0 ? `, mentioned=${mentionResult.resolved.map((m) => m.name ?? m.alias).join(", ")}` : ""})`,
        );
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  const listChatMembers = tool(
    "list_chat_members",
    "List human members of a Feishu group and return their open_id values for @ mentions. " +
      "Feishu's chat-members API does not return bot members; use list_mention_targets for known bots.",
    {
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
    async ({ chat_id, limit }) => {
      try {
        const targetChatId = chat_id ?? defaultChatId;
        const members = await fetchChatMembers(channel, targetChatId, limit);
        return textResult(
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
        return errorResult(errMsg(err));
      }
    },
  );

  const listMentionTargetsTool = tool(
    "list_mention_targets",
    "List configured/built-in mention target aliases that send_text can @ without scanning the current message. " +
      "Loaded Feishu bots are registered here, so Claude/Codex can proactively mention each other.",
    {},
    async () =>
      textResult(
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

  return createSdkMcpServer({
    name: "lark",
    version: "0.1.0",
    tools: [sendFile, sendImage, sendText, listChatMembers, listMentionTargetsTool],
  });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
