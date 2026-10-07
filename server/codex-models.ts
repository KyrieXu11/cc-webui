import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_FALLBACK_MODELS, defaultCodexModel, parseCodexModelsCache, type ModelOption } from "../src/lib/settings.ts";
import { readCodexModels } from "./codex-model-rpc.ts";

export type CodexModelCatalog = {
  source: "cli" | "cli-cache" | "fallback";
  fetchedAt: string | null;
  models: ModelOption[];
  defaultModel: string;
  stale?: boolean;
};

async function cachedCatalog(): Promise<CodexModelCatalog> {
  const file = process.env.CC_WEBUI_CODEX_MODELS_CACHE || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
  try {
    const handle = await fs.open(file, "r");
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("invalid cache");
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 2 * 1024 * 1024) throw new Error("cache too large");
      text = bytes.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
    const raw = JSON.parse(text);
    const models = parseCodexModelsCache(raw);
    if (models) return {
      source: "cli-cache",
      fetchedAt: typeof raw.fetched_at === "string" && Number.isFinite(Date.parse(raw.fetched_at)) ? raw.fetched_at : null,
      models,
      defaultModel: defaultCodexModel(models),
    };
  } catch { /* Missing/partial/corrupt cache does not break chat or admin UI. */ }
  return { source: "fallback", fetchedAt: null, models: CODEX_FALLBACK_MODELS, defaultModel: defaultCodexModel(CODEX_FALLBACK_MODELS) };
}

let lastGood: CodexModelCatalog | null = null;
let lastResult: CodexModelCatalog | null = null;
let expiresAt = 0;
let pending: Promise<CodexModelCatalog> | null = null;

export async function getCodexModelCatalog(options: { refresh?: boolean } = {}): Promise<CodexModelCatalog> {
  // An explicit file override remains useful for offline installs and tests;
  // it must never quietly contact the real CLI/account instead.
  if (process.env.CC_WEBUI_CODEX_MODELS_CACHE) return cachedCatalog();
  if (pending) return pending;
  if (!options.refresh && lastResult && Date.now() < expiresAt) return lastResult;
  pending = (async () => {
    try {
      const models = await readCodexModels();
      lastGood = { source: "cli", fetchedAt: new Date().toISOString(), models,
        defaultModel: defaultCodexModel(models) };
      lastResult = lastGood;
    } catch {
      // Never let an older CLI's shared cache erase a successful new catalog.
      lastResult = { ...(lastGood ?? await cachedCatalog()), stale: true };
    }
    expiresAt = Date.now() + 60_000;
    return lastResult;
  })();
  try { return await pending; } finally { pending = null; }
}
