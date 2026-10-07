import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-model-rpc-"));
const bin = path.join(tmp, "fake-codex"), fixture = path.join(tmp, "fixture.json"), calls = path.join(tmp, "calls");
process.env.CC_WEBUI_CODEX_BIN = bin;
process.env.CODEX_HOME = tmp;
delete process.env.CC_WEBUI_CODEX_MODELS_CACHE;
await fs.writeFile(bin, `#!${process.execPath}
const fs=require('node:fs'), rl=require('node:readline').createInterface({input:process.stdin});
fs.appendFileSync(${JSON.stringify(calls)},'started\\n');
rl.on('line',line=>{const r=JSON.parse(line),f=JSON.parse(fs.readFileSync(${JSON.stringify(fixture)},'utf8'));
 if(r.method==='initialize')process.stdout.write(JSON.stringify({id:r.id,result:{userAgent:'fake'}})+'\\n');
 if(r.method==='model/list'){
  if(f.hang)return;
  if(f.huge){process.stdout.write('x'.repeat(2*1024*1024+1));return;}
  if(f.fail){process.stdout.write(JSON.stringify({id:r.id,error:{message:'PRIVATE_ERROR'}})+'\\n');return;}
  const data=r.params.cursor?[f.models[1]]:[f.models[0]];
  process.stdout.write(JSON.stringify({id:r.id,result:{data,nextCursor:f.loop?'page2':r.params.cursor?null:'page2'}})+'\\n');
 }
});
`, { mode: 0o700 });
const model = (id: string, hidden = false) => ({ id, model: id, displayName: id, hidden,
  supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "ultra" }],
  defaultReasoningEffort: "high", account: "PRIVATE_ACCOUNT" });
const { readCodexModels } = await import("./codex-model-rpc.ts");
const { getCodexModelCatalog } = await import("./codex-models.ts");
try {
  await fs.writeFile(fixture, JSON.stringify({ models: [model("gpt-6.1-sol"), model("hidden-model", true)] }));
  const rows = await readCodexModels();
  assert.deepEqual(rows.map((m) => m.id), ["gpt-6.1-sol"]);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_ACCOUNT|hidden-model/);
  const catalogs = await Promise.all([getCodexModelCatalog(), getCodexModelCatalog(), getCodexModelCatalog({ refresh: true })]);
  assert.equal(catalogs[0].source, "cli");
  assert.deepEqual(catalogs[0], catalogs[1]);
  assert.equal((await fs.readFile(calls, "utf8")).trim().split("\n").length, 2, "one direct RPC + one coalesced catalog discovery");
  await fs.writeFile(fixture, JSON.stringify({ models: [model("gpt-next"), model("gpt-6.1-sol")] }));
  assert.equal((await getCodexModelCatalog()).models[0].id, "gpt-6.1-sol", "warm catalog does not respawn");
  assert.equal((await getCodexModelCatalog({ refresh: true })).models[0].id, "gpt-next");
  await fs.writeFile(fixture, JSON.stringify({ fail: true }));
  const stale = await getCodexModelCatalog({ refresh: true });
  assert.equal(stale.models[0].id, "gpt-next", "CLI failure cannot downgrade last good catalog to old shared cache");
  assert.equal(stale.stale, true);
  await assert.rejects(readCodexModels(), /rejected/);
  await fs.writeFile(fixture, JSON.stringify({ loop: true, models: [model("a"), model("b")] }));
  await assert.rejects(readCodexModels(), /cursor loop/);
  await fs.writeFile(fixture, JSON.stringify({ huge: true }));
  await assert.rejects(readCodexModels(), /too large/);
  await fs.writeFile(fixture, JSON.stringify({ hang: true }));
  await assert.rejects(readCodexModels(100), /timed out/);
  console.log("codex-model-rpc.test.ts ✓");
} finally { await fs.rm(tmp, { recursive: true, force: true }); }
