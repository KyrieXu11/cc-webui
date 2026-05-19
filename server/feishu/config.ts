import { homedir } from "node:os";
import path from "node:path";
import type { AgentId } from "../groups/store.ts";
import { loadDotEnvOnce } from "./env.ts";

loadDotEnvOnce();

export type BotKey = "claude" | "codex";

export type BotConfig = {
  key: BotKey;
  agentId: AgentId;
  appId: string;
  appSecret: string;
  // Only required for webhook mode. WS mode authenticates via app id/secret.
  encryptKey?: string;
  verifyToken?: string;
};

function read(prefix: string): Omit<BotConfig, "key" | "agentId"> | null {
  const appId = process.env[`${prefix}_APP_ID`];
  const appSecret = process.env[`${prefix}_APP_SECRET`];
  if (!appId || !appSecret) {
    if (appId && !appSecret) {
      console.warn(
        `[feishu] ${prefix}_APP_ID is set but ${prefix}_APP_SECRET is missing — skipping this bot`,
      );
    }
    return null;
  }
  return {
    appId,
    appSecret,
    encryptKey: process.env[`${prefix}_ENCRYPT_KEY`] || undefined,
    verifyToken: process.env[`${prefix}_VERIFY_TOKEN`] || undefined,
  };
}

export type TransportMode = "ws" | "webhook";

export function transportMode(): TransportMode {
  // Default to WS (simpler, no public URL needed). Opt into webhook with
  // FEISHU_USE_WEBHOOK=1.
  return process.env.FEISHU_USE_WEBHOOK === "1" ? "webhook" : "ws";
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

// Default cwd for groups auto-created from Feishu when a chat hasn't been
// bound yet. Priority: FEISHU_DEFAULT_CWD > CC_WEBUI_CWD > process.cwd().
export function defaultCwd(): string {
  const env = process.env.FEISHU_DEFAULT_CWD ?? process.env.CC_WEBUI_CWD;
  if (env) return path.resolve(expandTilde(env));
  return process.cwd();
}

export function resolveCwd(input: string): string {
  return path.resolve(expandTilde(input.trim()));
}

export function loadBotConfigs(): Map<BotKey, BotConfig> {
  const map = new Map<BotKey, BotConfig>();
  const claude = read("FEISHU_CLAUDE");
  if (claude) map.set("claude", { key: "claude", agentId: "claude", ...claude });
  const codex = read("FEISHU_CODEX");
  if (codex) map.set("codex", { key: "codex", agentId: "codex", ...codex });
  return map;
}

export function feishuDataDir(): string {
  const home = homedir();
  return path.join(home, ".cc-webui", "feishu");
}
