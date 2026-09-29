import assert from "node:assert/strict";
import { parseCodexModelsCache, configureCodexModels, availableEffortOptions, clampEffort, modelOptionsForProvider, modelCatalogVersion, subscribeModelCatalog, defaultModelForProvider, CODEX_FALLBACK_MODELS } from "./settings.ts";
const model = (slug: string, levels: string[], priority=1) => ({slug,display_name:slug,visibility:"list",priority,supported_reasoning_levels:levels.map(effort=>({effort})),default_reasoning_level:levels[0]});
const options = parseCodexModelsCache({ identity:{secret:"must-not-leak"},models:[model("gpt-6-astra",["low","high","max","ultra"],1),model("gpt-6-sol",["low","medium","high","max","ultra"],2),model("gpt-6-luna",["low","high","max"],3),{...model("hidden",["low"]),visibility:"hide"},model("--unsafe",["low"]),model("gpt-6-sol",["high"]),model("bad-level",["bogus"])] });
assert.deepEqual(options!.map(m=>m.id),["gpt-6-astra","gpt-6-sol","gpt-6-luna"]);
assert.ok(!JSON.stringify(options).includes("secret"));
let changes=0;const unsubscribe=subscribeModelCatalog(()=>changes++);
try {
  const before=modelCatalogVersion();
  assert.equal(configureCodexModels(options),true);
  assert.ok(modelCatalogVersion()>before);
  assert.equal(defaultModelForProvider("codex"),"gpt-6-sol");
  assert.deepEqual(availableEffortOptions("gpt-6-astra").map(e=>e.id),["low","high","max","ultra"]);
  assert.equal(clampEffort("ultra","gpt-6-luna"),"max");
  assert.ok(!availableEffortOptions("opus").some(e=>e.id==="ultra"));
  assert.ok(!availableEffortOptions("opus").some(e=>e.id==="none"));
  assert.ok(availableEffortOptions("opus").some(e=>e.id==="max"));
  configureCodexModels(options);assert.equal(changes,1,"same catalogue is not a new user preference version");
  assert.equal(configureCodexModels(null),false);
  assert.equal(modelOptionsForProvider("codex")[0].id,"gpt-6-astra","bad refresh keeps last valid models");
  assert.equal(parseCodexModelsCache({models:"wrong"}),null);
} finally { unsubscribe();configureCodexModels(CODEX_FALLBACK_MODELS); }
