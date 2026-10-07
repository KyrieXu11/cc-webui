import { codexCatalogSource, configureCodexModels } from "./settings";

let pending: Promise<boolean> | null = null;
let pendingForced = false;
export async function refreshCodexModels(force = false): Promise<boolean> {
  if (pending) {
    if (!force || pendingForced) return pending;
    await pending;
    return refreshCodexModels(true);
  }
  pendingForced = force;
  pending = (async () => {
    try {
      const response = await fetch(`/api/meta/models${force ? "?refresh=1" : ""}`, {
        cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      const { codex } = await response.json();
      const source = codex?.source === "cli" ? "cli" : codex?.source === "cli-cache" ? "cli-cache" : "fallback";
      if (source === "fallback" && codexCatalogSource() !== "fallback") return false;
      if (codex?.stale && codexCatalogSource() !== "fallback") return false;
      const valid = configureCodexModels(codex?.models, source);
      return valid && !codex?.stale && source !== "fallback";
    } catch { return false; }
  })();
  try { return await pending; } finally { pending = null; }
}
