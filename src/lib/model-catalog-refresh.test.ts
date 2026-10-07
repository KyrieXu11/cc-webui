import assert from "node:assert/strict";
import { refreshCodexModels } from "./model-catalog.ts";
import { CODEX_FALLBACK_MODELS, configureCodexModels, modelOptionsForProvider } from "./settings.ts";

const original = globalThis.fetch;
const model = { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", supportedEfforts: ["high", "ultra"] };
let requests = 0;
try {
  globalThis.fetch = async (input, options) => {
    requests++;
    assert.equal(String(input), "/api/meta/models?refresh=1");
    assert.equal(options?.cache, "no-store");
    return new Response(JSON.stringify({ codex: { source: "cli", models: [model] } }));
  };
  assert.deepEqual(await Promise.all([refreshCodexModels(true), refreshCodexModels(true)]), [true, true]);
  assert.equal(requests, 1, "concurrent manual refreshes share one request");
  assert.equal(modelOptionsForProvider("codex")[0].id, "gpt-6.1-sol");
  globalThis.fetch = async () => new Response(JSON.stringify({ codex: { source: "fallback", models: CODEX_FALLBACK_MODELS } }));
  assert.equal(await refreshCodexModels(), false);
  assert.equal(modelOptionsForProvider("codex")[0].id, "gpt-6.1-sol", "an unavailable catalog cannot silently downgrade a valid one");
  globalThis.fetch = async () => new Response(JSON.stringify({ codex: { source: "cli", models: [model], stale: true } }));
  assert.equal(await refreshCodexModels(true), false, "stale catalog must not claim a successful live refresh");
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal(await refreshCodexModels(), false);
  assert.equal(modelOptionsForProvider("codex")[0].id, "gpt-6.1-sol");
} finally { globalThis.fetch = original; configureCodexModels(CODEX_FALLBACK_MODELS, "fallback"); }
console.log("model-catalog-refresh.test.ts ✓");
