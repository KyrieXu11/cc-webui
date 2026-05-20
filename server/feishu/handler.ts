import { promises as fs } from "node:fs";
import type * as lark from "@larksuiteoapi/node-sdk";
import {
  readConfig,
  writeConfig,
  type GroupEffort,
  type GroupMode,
} from "../groups/config.ts";
import { createGroup, relocateGroup } from "../groups/lifecycle.ts";
import { readIndex } from "../groups/store.ts";
import {
  getInFlightTurn,
  startTurn,
  stopTurn,
} from "../groups/orchestrator.ts";
import type { ImageAttachment } from "../groups/store.ts";
import { bridgeTurn } from "./bridge.ts";
import { getBinding, removeBinding, setBinding } from "./binding.ts";
import { createLarkMcpServer } from "./lark-mcp.ts";
import { fetchQuotedContext } from "./quote.ts";
import {
  defaultCwd,
  resolveCwd,
  type BotConfig,
} from "./config.ts";
import {
  HELP_TEXT,
  parseCommand,
} from "./parse.ts";

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

const VALID_EFFORTS: readonly GroupEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const MODE_ALIASES: Record<string, GroupMode> = {
  default: "default",
  auto: "auto",
  edits: "acceptEdits",
  acceptedits: "acceptEdits",
  yolo: "bypassPermissions",
  bypass: "bypassPermissions",
  bypasspermissions: "bypassPermissions",
  plan: "plan",
  dontask: "dontAsk",
  deny: "dontAsk",
};

function resolveModelName(input: string): string {
  return MODEL_ALIASES[input.toLowerCase()] ?? input;
}

async function isAccessibleDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function createBoundGroup(
  chatId: string,
  cwd: string,
): Promise<string> {
  const id = await createGroup({
    title: `飞书 ${chatId.slice(-6)}`,
    cwd,
  });
  await setBinding(chatId, id);
  return id;
}

// Entry point invoked from ws.ts on each normalized message event.
// SDK's policy.requireMention has already filtered out group messages
// without @ bot; SDK's safety.dedup has filtered duplicates.
export async function handleNormalizedMessage(
  bot: BotConfig,
  channel: lark.LarkChannel,
  msg: lark.NormalizedMessage,
): Promise<void> {
  // Only handle text messages.
  if (msg.rawContentType !== "text") return;

  const chatId = msg.chatId;
  const messageId = msg.messageId;
  const text = msg.content.trim();
  if (!text) return;

  console.log(
    `[feishu ${bot.key}] inbound chat_type=${msg.chatType} chat_id=${chatId} mid=${messageId} mentionedBot=${msg.mentionedBot}`,
  );

  const cmd = parseCommand(text);
  switch (cmd.kind) {
    case "help":
      await reply(channel, messageId, HELP_TEXT);
      return;

    case "bind":
      await setBinding(chatId, cmd.gid);
      await reply(channel, messageId, `✅ 已绑定到 group ${cmd.gid}`);
      return;

    case "unbind": {
      const ok = await removeBinding(chatId);
      await reply(channel, messageId, ok ? "✅ 已解绑" : "ℹ️ 当前群未绑定");
      return;
    }

    case "cwd": {
      const gid = await getBinding(chatId);
      if (!gid) {
        await reply(
          channel,
          messageId,
          `ℹ️ 当前群未绑定。下次 @ 我发消息时会自动建会话，默认 cwd: ${defaultCwd()}`,
        );
        return;
      }
      try {
        const cfg = await readConfig(gid);
        await reply(channel, messageId, `📁 cwd: ${cfg.cwd}\n🆔 gid: ${gid}`);
      } catch {
        await reply(
          channel,
          messageId,
          `⚠️ 绑定的 group ${gid} 已不存在，请 /unbind 后重试`,
        );
      }
      return;
    }

    case "cd": {
      if (!cmd.path) {
        const gid = await getBinding(chatId);
        let current = defaultCwd();
        if (gid) {
          try {
            current = (await readConfig(gid)).cwd;
          } catch {
            /* fall back to default */
          }
        }
        await reply(
          channel,
          messageId,
          `用法：\`/cd <path>\` 换目录（保留历史）\n当前 cwd: \`${current}\``,
        );
        return;
      }
      const target = resolveCwd(cmd.path);
      if (!(await isAccessibleDir(target))) {
        await reply(channel, messageId, `⚠️ 目录不存在或不可读: ${target}`);
        return;
      }
      const gid = await getBinding(chatId);
      if (!gid) {
        // No binding yet — fresh start at target cwd.
        const newGid = await createBoundGroup(chatId, target);
        await reply(
          channel,
          messageId,
          `✅ 已切到 ${target}\n🆕 新会话 ${newGid.slice(0, 8)}…`,
        );
        return;
      }
      if (getInFlightTurn(gid)) {
        await reply(
          channel,
          messageId,
          "⏳ 当前轮还在跑，请 /stop 后再切目录。",
        );
        return;
      }
      try {
        await relocateGroup(gid, target);
      } catch (err) {
        await reply(channel, messageId, `❌ 切换失败: ${errMsg(err)}`);
        return;
      }
      await reply(
        channel,
        messageId,
        `✅ 已切到 ${target}\n📜 对话历史保留`,
      );
      return;
    }

    case "new": {
      // /new <path>: brand-new session at a new cwd (resets history too).
      if (cmd.path) {
        const target = resolveCwd(cmd.path);
        if (!(await isAccessibleDir(target))) {
          await reply(channel, messageId, `⚠️ 目录不存在或不可读: ${target}`);
          return;
        }
        const gid = await createBoundGroup(chatId, target);
        await reply(
          channel,
          messageId,
          `🆕 新会话\n📁 cwd: ${target}\n🆔 ${gid.slice(0, 8)}…`,
        );
        return;
      }
      // /new without args: keep current cwd, blank slate.
      const old = await getBinding(chatId);
      let cwd = defaultCwd();
      if (old) {
        try {
          cwd = (await readConfig(old)).cwd;
        } catch {
          /* fall back to default */
        }
      }
      const gid = await createBoundGroup(chatId, cwd);
      await reply(
        channel,
        messageId,
        `🆕 新会话\n📁 cwd: ${cwd}\n🆔 ${gid.slice(0, 8)}…`,
      );
      return;
    }

    case "model": {
      const ctx = await ensureBoundConfig(channel, chatId, messageId);
      if (!ctx) return;
      const participant = ctx.cfg.participants.find((p) => p.id === bot.agentId);
      if (!participant) {
        await reply(channel, messageId, `⚠️ group 配置里没有 ${bot.agentId} 参与者`);
        return;
      }
      if (!cmd.name) {
        await reply(channel, messageId, `🤖 当前模型: ${participant.model}`);
        return;
      }
      participant.model = resolveModelName(cmd.name);
      ctx.cfg.updatedAt = Date.now();
      try {
        await writeConfig(ctx.cfg);
      } catch (err) {
        await reply(channel, messageId, `❌ 切换失败: ${errMsg(err)}`);
        return;
      }
      await reply(channel, messageId, `✅ 模型已切到 ${participant.model}`);
      return;
    }

    case "effort": {
      const ctx = await ensureBoundConfig(channel, chatId, messageId);
      if (!ctx) return;
      const participant = ctx.cfg.participants.find((p) => p.id === bot.agentId);
      if (!participant) {
        await reply(channel, messageId, `⚠️ group 配置里没有 ${bot.agentId} 参与者`);
        return;
      }
      if (!cmd.level) {
        await reply(
          channel,
          messageId,
          `🧠 当前 effort: ${participant.effort ?? "medium"}`,
        );
        return;
      }
      const lvl = cmd.level.toLowerCase() as GroupEffort;
      if (!VALID_EFFORTS.includes(lvl)) {
        await reply(
          channel,
          messageId,
          `⚠️ 无效 effort: ${cmd.level}\n可选: ${VALID_EFFORTS.join(" / ")}`,
        );
        return;
      }
      participant.effort = lvl;
      ctx.cfg.updatedAt = Date.now();
      try {
        await writeConfig(ctx.cfg);
      } catch (err) {
        await reply(channel, messageId, `❌ 切换失败: ${errMsg(err)}`);
        return;
      }
      await reply(channel, messageId, `✅ effort 已切到 ${lvl}`);
      return;
    }

    case "mode": {
      const ctx = await ensureBoundConfig(channel, chatId, messageId);
      if (!ctx) return;
      const participant = ctx.cfg.participants.find((p) => p.id === bot.agentId);
      if (!participant) {
        await reply(channel, messageId, `⚠️ group 配置里没有 ${bot.agentId} 参与者`);
        return;
      }
      if (!cmd.name) {
        await reply(
          channel,
          messageId,
          `🔒 当前 mode: ${participant.mode ?? "default"}`,
        );
        return;
      }
      const resolved = MODE_ALIASES[cmd.name.toLowerCase()];
      if (!resolved) {
        await reply(
          channel,
          messageId,
          `⚠️ 未知 mode: ${cmd.name}\n可选: default / auto / edits / yolo / plan / dontAsk`,
        );
        return;
      }
      participant.mode = resolved;
      ctx.cfg.updatedAt = Date.now();
      try {
        await writeConfig(ctx.cfg);
      } catch (err) {
        await reply(channel, messageId, `❌ 切换失败: ${errMsg(err)}`);
        return;
      }
      await reply(channel, messageId, `✅ mode 已切到 ${resolved}`);
      return;
    }

    case "resume": {
      const idx = await readIndex();
      // Anchor cwd for filtering — current binding's cwd if any, else default.
      const currentGid = await getBinding(chatId);
      let anchorCwd = defaultCwd();
      if (currentGid) {
        try {
          anchorCwd = (await readConfig(currentGid)).cwd;
        } catch {
          /* keep default */
        }
      }
      if (!cmd.prefix) {
        const recent = idx.groups
          .filter((g) => g.cwd === anchorCwd)
          .sort((a, b) => b.lastTs - a.lastTs)
          .slice(0, 10);
        if (recent.length === 0) {
          await reply(
            channel,
            messageId,
            `ℹ️ 当前 cwd 还没有会话\n📁 ${anchorCwd}\n要换目录用 \`/cd <path>\` 或 \`/new <path>\`。`,
          );
          return;
        }
        const lines = [
          `📜 ${anchorCwd} 下的最近 ${recent.length} 个会话（用 \`/resume <id前缀>\` 切过去）：`,
          "",
        ];
        for (const r of recent) {
          const id8 = r.id.slice(0, 8);
          const snippet = (r.lastSnippet || "").slice(0, 50).replace(/\n/g, " ");
          const date = new Date(r.lastTs).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          const marker = r.id === currentGid ? "▶ " : "  ";
          lines.push(`${marker}\`${id8}\` · ${date}`);
          if (snippet) {
            lines.push(
              `    ${snippet}${r.lastSnippet && r.lastSnippet.length > 50 ? "…" : ""}`,
            );
          }
        }
        await reply(channel, messageId, lines.join("\n"));
        return;
      }
      // Prefix lookup is global — user may want to switch to a session in
      // another cwd (which will pull the binding's cwd along with it).
      const matches = idx.groups.filter((g) => g.id.startsWith(cmd.prefix!));
      if (matches.length === 0) {
        await reply(
          channel,
          messageId,
          `⚠️ 找不到以 \`${cmd.prefix}\` 开头的会话。/resume 看全部列表。`,
        );
        return;
      }
      if (matches.length > 1) {
        const list = matches
          .slice(0, 5)
          .map((m) => `  \`${m.id.slice(0, 12)}\` · 📁 ${m.cwd}`)
          .join("\n");
        await reply(
          channel,
          messageId,
          `⚠️ 前缀 \`${cmd.prefix}\` 匹配多个，请给更长前缀：\n${list}`,
        );
        return;
      }
      const target = matches[0];
      await setBinding(chatId, target.id);
      await reply(
        channel,
        messageId,
        `✅ 已切到会话 \`${target.id.slice(0, 8)}…\`\n📁 cwd: ${target.cwd}`,
      );
      return;
    }

    case "status": {
      const gid = await getBinding(chatId);
      if (!gid) {
        await reply(
          channel,
          messageId,
          `ℹ️ 当前群未绑定 (默认 cwd: ${defaultCwd()})`,
        );
        return;
      }
      let cwd = "?";
      try {
        cwd = (await readConfig(gid)).cwd;
      } catch {
        /* keep '?' */
      }
      const inflight = getInFlightTurn(gid);
      await reply(
        channel,
        messageId,
        [
          `🆔 ${gid}`,
          `📁 ${cwd}`,
          inflight ? "⏳ 正在跑一轮" : "💤 空闲",
        ].join("\n"),
      );
      return;
    }

    case "stop": {
      const gid = await getBinding(chatId);
      if (!gid) {
        await reply(channel, messageId, "ℹ️ 当前群未绑定");
        return;
      }
      const ok = stopTurn(gid);
      await reply(
        channel,
        messageId,
        ok ? "🛑 已请求中止" : "ℹ️ 没有正在跑的一轮",
      );
      return;
    }

    case "chat": {
      let gid = await getBinding(chatId);
      if (!gid) {
        gid = await createBoundGroup(chatId, defaultCwd());
        console.log(
          `[feishu ${bot.key}] auto-created group ${gid} for chat ${chatId} cwd=${defaultCwd()}`,
        );
      }

      // Pull images + text from the message the user is replying-to, if any.
      // Lets users do "发图 → 引用 + @bot 文字" (handy on mobile where
      // image+text in one shot isn't supported).
      let images: ImageAttachment[] = [];
      let textWithQuote = cmd.text;
      if (msg.replyToMessageId) {
        const q = await fetchQuotedContext(channel, msg.replyToMessageId);
        images = q.images;
        if (q.text) {
          const quoted = q.text.replace(/\n/g, "\n> ");
          textWithQuote = `> [引用]: ${quoted}\n\n${cmd.text}`;
        }
        if (images.length > 0 || q.text) {
          console.log(
            `[feishu ${bot.key}] quoted ${msg.replyToMessageId}: ${images.length} image(s), ${q.text.length} char text`,
          );
        }
      }

      // Per-turn MCP server bound to this chat so Claude can push files /
      // images back to Feishu under the bot's identity (no OAuth required).
      const larkMcp = createLarkMcpServer({
        channel,
        defaultChatId: chatId,
      });

      let result;
      try {
        result = await startTurn({
          gid,
          text: textWithQuote,
          images,
          recipients: [bot.agentId],
          extraMcpServers: { lark: larkMcp },
        });
      } catch (err) {
        const m = errMsg(err);
        await reply(
          channel,
          messageId,
          m === "turn_busy"
            ? "⏳ 上一轮还在进行中，请稍候或 /stop。"
            : `❌ 启动失败: ${m}`,
        );
        return;
      }
      // Fire-and-forget: do NOT await bridgeTurn here. LarkChannel's safety
      // module serializes events per chat_id — if this handler stays awaiting
      // bridge until turn_end, a subsequent cardAction (e.g. permission card
      // click) is queued behind us and never reaches our cardAction handler,
      // which means the permission never resolves and the turn deadlocks.
      void bridgeTurn({
        bot,
        channel,
        chatId,
        parentMessageId: messageId,
        gid,
        turn: result.turn,
      }).catch((err) => {
        console.error(`[feishu ${bot.key}] bridge crash:`, err);
      });
      return;
    }
  }
}

async function ensureBoundConfig(
  channel: lark.LarkChannel,
  chatId: string,
  messageId: string,
): Promise<{ gid: string; cfg: Awaited<ReturnType<typeof readConfig>> } | null> {
  const gid = await getBinding(chatId);
  if (!gid) {
    await reply(
      channel,
      messageId,
      "ℹ️ 当前群未绑定。先 @ 我发一条消息（会自动建会话）。",
    );
    return null;
  }
  try {
    const cfg = await readConfig(gid);
    return { gid, cfg };
  } catch {
    await reply(channel, messageId, "⚠️ 绑定的 group 已不存在，请 /unbind 重试");
    return null;
  }
}

async function reply(
  channel: lark.LarkChannel,
  messageId: string,
  text: string,
): Promise<void> {
  try {
    await channel.send(messageId, { text }, { replyTo: messageId });
  } catch (err) {
    console.error(`[feishu reply] failed:`, err);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
