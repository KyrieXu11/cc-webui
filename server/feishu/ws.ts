import * as lark from "@larksuiteoapi/node-sdk";
import type { BotConfig } from "./config.ts";
import { handleCardAction } from "./card-action.ts";
import { handleNormalizedMessage } from "./handler.ts";

const CHANNELS = new Map<string, lark.LarkChannel>();

export function getChannel(appId: string): lark.LarkChannel | undefined {
  return CHANNELS.get(appId);
}

export async function startChannel(bot: BotConfig): Promise<void> {
  if (CHANNELS.has(bot.appId)) return;

  const channel = lark.createLarkChannel({
    appId: bot.appId,
    appSecret: bot.appSecret,
    transport: "websocket",
    loggerLevel: lark.LoggerLevel.warn,
    policy: {
      // group-chat: require @ mention; DM: open to any sender.
      requireMention: true,
      dmMode: "open",
    },
    safety: {
      // SDK-side dedup + stale message filter — replaces our dedupe.ts.
      dedup: { ttl: 5 * 60_000, maxEntries: 4096 },
      staleMessageWindowMs: 30_000,
    },
  });

  channel.on("message", async (msg) => {
    try {
      await handleNormalizedMessage(bot, channel, msg);
    } catch (err) {
      console.error(`[feishu ${bot.key}] handle:`, err);
    }
  });
  channel.on("cardAction", (evt) => {
    console.log(
      `[feishu ${bot.key}] cardAction received: action.value=${JSON.stringify(evt.action?.value)} operator=${evt.operator?.name ?? evt.operator?.openId}`,
    );
    try {
      handleCardAction(bot, evt);
    } catch (err) {
      console.error(`[feishu ${bot.key}] cardAction:`, err);
    }
  });

  channel.on("error", (err) => {
    console.error(`[feishu ${bot.key} channel] error:`, err);
  });
  channel.on("reject", (evt) => {
    console.warn(
      `[feishu ${bot.key} channel] rejected msg=${evt.messageId} reason=${evt.reason}`,
    );
  });
  channel.on("reconnecting", () => {
    console.warn(`[feishu ${bot.key} channel] reconnecting...`);
  });
  channel.on("reconnected", () => {
    console.log(`[feishu ${bot.key} channel] reconnected`);
  });

  CHANNELS.set(bot.appId, channel);

  try {
    await channel.connect();
    console.log(
      `[feishu ${bot.key} channel] connected (bot=${channel.botIdentity?.name ?? "?"})`,
    );
  } catch (err) {
    console.error(`[feishu ${bot.key} channel] connect failed:`, err);
    CHANNELS.delete(bot.appId);
  }
}

export async function stopAllChannels(): Promise<void> {
  for (const c of CHANNELS.values()) {
    try {
      await c.disconnect();
    } catch {
      /* ignore */
    }
  }
  CHANNELS.clear();
}
