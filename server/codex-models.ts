import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_FALLBACK_MODELS, defaultCodexModel, parseCodexModelsCache, type ModelOption } from "../src/lib/settings.ts";

export type CodexModelCatalog = {
  source: "cli-cache" | "fallback";
  fetchedAt: string | null;
  models: ModelOption[];
  defaultModel: string;
};

export async function getCodexModelCatalog(): Promise<CodexModelCatalog> {
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
