import type * as lark from "@larksuiteoapi/node-sdk";
import type { BotConfig } from "./config.ts";
import { loadDotEnvOnce } from "./env.ts";

loadDotEnvOnce();

export type MentionTargetSource = "bot" | "env" | "runtime";
export const DEFAULT_MEMBER_LIMIT = 100;
export const MAX_MEMBER_LIMIT = 500;

export type MentionTarget = {
  alias: string;
  openId: string;
  name?: string;
  source: MentionTargetSource;
};

type MentionAliasConfig =
  | string
  | {
      open_id?: string;
      openId?: string;
      id?: string;
      name?: string;
      aliases?: string[];
    };

const targets = new Map<string, MentionTarget>();
let envLoaded = false;

// Register every loaded Feishu bot as an addressable mention target so one bot
// can proactively hand off work to another one (e.g. Claude → Codex) without
// requiring the target bot to appear in the user's original message.
export function registerBotMentionTarget(
  bot: BotConfig,
  identity: lark.BotIdentity | undefined,
): void {
  if (!identity?.openId) return;
  const aliases = new Set<string>([
    bot.key,
    bot.agentId,
    `${bot.key}-bot`,
    `${bot.key}bot`,
  ]);
  if (identity.name) {
    aliases.add(identity.name);
    aliases.add(identity.name.replace(/\s+/g, ""));
  }
  for (const alias of aliases) {
    registerMentionTarget(alias, {
      openId: identity.openId,
      name: identity.name || `${bot.key}-bot`,
      source: "bot",
    });
  }
}

export function registerMentionTarget(
  alias: string,
  target: Omit<MentionTarget, "alias">,
): void {
  const key = normalizeMentionAlias(alias);
  if (!key || !target.openId) return;
  targets.set(key, {
    alias: key,
    openId: target.openId,
    name: target.name,
    source: target.source,
  });
}

export function listMentionTargets(): MentionTarget[] {
  loadConfiguredMentionTargets();
  return Array.from(targets.values()).sort((a, b) =>
    a.alias.localeCompare(b.alias),
  );
}

export function knownMentionTargetSummary(max = 24): string {
  const list = listMentionTargets();
  if (list.length === 0) {
    return "No named mention targets are configured yet. Pass raw Feishu open_id values, or configure FEISHU_MENTION_ALIASES.";
  }
  const names = list.slice(0, max).map((t) => `${t.alias}${t.name ? `(${t.name})` : ""}`);
  const suffix = list.length > max ? `, ... +${list.length - max} more` : "";
  return `Known mention targets: ${names.join(", ")}${suffix}`;
}

export function resolveMentionTargets(
  requested: string[] | undefined,
): {
  mentions: lark.MentionInfo[];
  unresolved: string[];
  resolved: MentionTarget[];
} {
  loadConfiguredMentionTargets();
  const mentions: lark.MentionInfo[] = [];
  const resolved: MentionTarget[] = [];
  const unresolved: string[] = [];
  const seenOpenIds = new Set<string>();

  for (const raw of requested ?? []) {
    const input = raw.trim();
    if (!input) continue;
    const alias = normalizeMentionAlias(input);
    const configured = targets.get(alias);
    const target =
      configured ??
      (looksLikeOpenId(input)
        ? {
            alias: input,
            openId: input,
            name: input,
            source: "runtime" as const,
          }
        : undefined);
    if (!target) {
      unresolved.push(input);
      continue;
    }
    if (seenOpenIds.has(target.openId)) continue;
    seenOpenIds.add(target.openId);
    resolved.push(target);
    mentions.push({
      key: `@${target.alias}`,
      openId: target.openId,
      name: target.name ?? target.alias,
      isBot: target.source === "bot" ? true : undefined,
    });
  }

  return { mentions, unresolved, resolved };
}

export function buildMentionInfos(
  mentionTargets: string[] | undefined,
  mentionOpenIds: string[] | undefined,
): {
  mentions: lark.MentionInfo[];
  resolved: MentionTarget[];
  error?: string;
} {
  const byAlias = resolveMentionTargets(mentionTargets);
  if (byAlias.unresolved.length > 0) {
    return {
      mentions: [],
      resolved: [],
      error:
        `unknown mention target(s): ${byAlias.unresolved.join(", ")}. ` +
        "Call list_mention_targets or list_chat_members first, or pass raw open_id in mention_open_ids.",
    };
  }

  const mentions = [...byAlias.mentions];
  const resolved = [...byAlias.resolved];
  const seenOpenIds = new Set(mentions.map((m) => m.openId).filter(Boolean));
  for (const openId of mentionOpenIds ?? []) {
    const id = openId.trim();
    if (!id || seenOpenIds.has(id)) continue;
    seenOpenIds.add(id);
    mentions.push({ key: `@${id}`, openId: id, name: id });
    resolved.push({ alias: id, openId: id, name: id, source: "runtime" });
  }
  return { mentions, resolved };
}

export async function fetchChatMembers(
  channel: lark.LarkChannel,
  chatId: string,
  limit = DEFAULT_MEMBER_LIMIT,
): Promise<Array<{ open_id: string; name?: string; tenant_key?: string }>> {
  const max = Math.min(Math.max(1, limit), MAX_MEMBER_LIMIT);
  const members: Array<{ open_id: string; name?: string; tenant_key?: string }> = [];
  const iter = await channel.rawClient.im.v1.chatMembers.getWithIterator({
    path: { chat_id: chatId },
    params: {
      member_id_type: "open_id",
      page_size: Math.min(max, 100),
    },
  });

  for await (const page of iter) {
    for (const item of page?.items ?? []) {
      if (!item.member_id) continue;
      members.push({
        open_id: item.member_id,
        name: item.name,
        tenant_key: item.tenant_key,
      });
      if (members.length >= max) return members;
    }
  }
  return members;
}

function loadConfiguredMentionTargets(env = process.env): void {
  if (envLoaded) return;
  envLoaded = true;

  const raw = env.FEISHU_MENTION_ALIASES ?? env.FEISHU_MENTION_TARGETS;
  if (!raw?.trim()) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("[feishu mentions] failed to parse FEISHU_MENTION_ALIASES:", err);
    return;
  }

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const o = entry as MentionAliasConfig & { alias?: string };
      if (typeof o.alias === "string") registerConfiguredAlias(o.alias, o);
    }
    return;
  }

  if (!parsed || typeof parsed !== "object") return;
  for (const [alias, value] of Object.entries(parsed as Record<string, MentionAliasConfig>)) {
    registerConfiguredAlias(alias, value);
  }
}

function registerConfiguredAlias(alias: string, value: MentionAliasConfig): void {
  if (typeof value === "string") {
    registerMentionTarget(alias, {
      openId: value,
      name: alias,
      source: "env",
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  const openId = value.open_id ?? value.openId ?? value.id;
  if (!openId) return;
  const aliases = new Set([alias, ...(value.aliases ?? [])]);
  for (const a of aliases) {
    registerMentionTarget(a, {
      openId,
      name: value.name ?? alias,
      source: "env",
    });
  }
}

function normalizeMentionAlias(input: string): string {
  return input.trim().replace(/^@+/, "").toLowerCase();
}

function looksLikeOpenId(input: string): boolean {
  return /^(ou|on|oc|cli|app)_[A-Za-z0-9_-]+$/.test(input);
}

export function resetMentionTargetsForTest(): void {
  targets.clear();
  envLoaded = false;
}
