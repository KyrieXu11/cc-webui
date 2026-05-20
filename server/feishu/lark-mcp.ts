import { promises as fs } from "node:fs";
import path from "node:path";
import type * as lark from "@larksuiteoapi/node-sdk";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// In-process MCP server that exposes Feishu IM send capabilities to Claude.
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
    "Send a plain-text message to a Feishu chat. Useful for posting " +
      "side-channel notifications to *other* chats (the current chat already " +
      "receives Claude's streaming reply). chat_id defaults to the current chat.",
    {
      text: z.string().describe("Text content to send"),
      chat_id: z
        .string()
        .optional()
        .describe("Feishu chat_id. Defaults to the current chat."),
    },
    async ({ text, chat_id }) => {
      try {
        const res = await channel.send(chat_id ?? defaultChatId, { text });
        return textResult(
          `sent text → ${chat_id ?? defaultChatId} (message_id=${res.messageId})`,
        );
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  return createSdkMcpServer({
    name: "lark",
    version: "0.1.0",
    tools: [sendFile, sendImage, sendText],
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
