import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"cc-models-"));
Object.assign(process.env,{CC_WEBUI_CODEX_MODELS_CACHE:path.join(tmp,"models.json"),CC_WEBUI_DB:path.join(tmp,"db"),CC_WEBUI_WORKSPACES_DIR:path.join(tmp,"workspaces"),CC_WEBUI_COOKIE_SECRET_FILE:path.join(tmp,"cookie"),CC_WEBUI_CLAUDE_PROJECTS_DIR:path.join(tmp,"claude"),CODEX_SESSIONS_DIR:path.join(tmp,"codex"),CC_WEBUI_GROUPS_DIR:path.join(tmp,"groups")});
const {getCodexModelCatalog}=await import("./codex-models.ts");
const {createApp}=await import("./app.ts");const {createUser,setAllowedProviders,getUserDefaults}=await import("./auth/users.ts");const {issueSession,SESSION_COOKIE}=await import("./auth/session.ts");const {closeDb}=await import("./db.ts");
const option=(slug:string,levels:string[])=>({slug,display_name:slug,visibility:"list",supported_reasoning_levels:levels.map(effort=>({effort}))});
try {
  assert.equal((await getCodexModelCatalog()).source,"fallback");
  await fs.writeFile(process.env.CC_WEBUI_CODEX_MODELS_CACHE!,JSON.stringify({identity:{account_id:"PRIVATE_ACCOUNT"},fetched_at:"2026-09-29T00:00:00Z",models:[option("gpt-6-sol",["low","high","max","ultra"]),option("gpt-6-luna",["low","high","max"])]}));
  const catalog=await getCodexModelCatalog();assert.equal(catalog.source,"cli-cache");assert.equal(catalog.models.length,2);assert.ok(!JSON.stringify(catalog).includes("PRIVATE_ACCOUNT"));
  const root=createUser({username:"root",password:"pw",role:"admin",allowedPaths:[tmp]});const member=createUser({username:"member",password:"pw",role:"user",allowedPaths:[tmp]});setAllowedProviders(member.id,["codex"]);
  const app=createApp(),cookie=`${SESSION_COOKIE}=${issueSession(root.id)}`;
  const meta=await app.request("/api/meta",{headers:{cookie}});const data=await meta.json();assert.equal(data.models.codex.models[0].id,"gpt-6-sol");assert.ok(!JSON.stringify(data).includes("PRIVATE_ACCOUNT"));
  const modelOnly=await app.request("/api/meta/models?refresh=1",{headers:{cookie}});
  assert.equal(modelOnly.headers.get("cache-control"),"no-store");
  assert.equal((await modelOnly.json()).codex.models[0].id,"gpt-6-sol");
  assert.equal((await app.request("/api/meta/models")).status,401);
  const patch=(model:string,effort:string)=>app.request(`/api/admin/users/${member.id}`,{method:"PATCH",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({defaults:{provider:"codex",model,effort}})});
  assert.equal((await patch("gpt-6-sol","ultra")).status,200);
  assert.equal(getUserDefaults(member.id)!.effort,"ultra");
  assert.equal((await patch("gpt-6-luna","ultra")).status,400);
  assert.equal((await patch("gpt-reserve","high")).status,400);
  // Models refresh independently from the 60s slash-command cache.
  await fs.writeFile(process.env.CC_WEBUI_CODEX_MODELS_CACHE!,JSON.stringify({models:[option("gpt-future",["low","high"])]}));
  const next=await(await app.request("/api/meta",{headers:{cookie}})).json();assert.equal(next.cached,true);assert.equal(next.models.codex.models[0].id,"gpt-future");
  await fs.writeFile(process.env.CC_WEBUI_CODEX_MODELS_CACHE!,"{partial");assert.equal((await getCodexModelCatalog()).source,"fallback");
  await fs.writeFile(process.env.CC_WEBUI_CODEX_MODELS_CACHE!,"x".repeat(2*1024*1024+1));assert.equal((await getCodexModelCatalog()).source,"fallback");
}finally{closeDb();await fs.rm(tmp,{recursive:true,force:true});}
