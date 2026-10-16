import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-steering-routes-"));
Object.assign(process.env, { CC_WEBUI_DB: path.join(tmp, "db"), CC_WEBUI_WORKSPACES_DIR: path.join(tmp, "workspaces"),
  CC_WEBUI_GROUPS_DIR: path.join(tmp, "groups"), CC_WEBUI_CLAUDE_PROJECTS_DIR: path.join(tmp, "claude"),
  CODEX_SESSIONS_DIR: path.join(tmp, "codex"), CC_WEBUI_COOKIE_SECRET_FILE: path.join(tmp, "cookie"),
  CC_WEBUI_PROJECT_MEMORY_DIR: path.join(tmp, "memory"), CC_WEBUI_PROJECT_MEMORY_ENABLED: "1" });
const codexId = randomUUID(), claudeId = randomUUID(), capture = path.join(tmp, "input.jsonl"), fake = path.join(tmp, "fake.cjs");
await fs.writeFile(fake, `#!/usr/bin/env node
const fs=require('node:fs'), app=process.argv.includes('app-server');
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');let n=0;
const notify=(method,params)=>out({method,params:{threadId:${JSON.stringify(codexId)},...params}});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(app){
  if(r.method==='initialize')return out({id:r.id,result:{}});
  if(r.method==='thread/start')return out({id:r.id,result:{thread:{id:${JSON.stringify(codexId)}}}});
  if(r.method==='turn/start'){
   out({id:r.id,result:{turn:{id:'native-turn',status:'inProgress'}}});
   notify('turn/started',{turn:{id:'native-turn',status:'inProgress'}});
   return notify('item/started',{turnId:'native-turn',item:{id:'tool',type:'commandExecution',command:'synthetic',status:'inProgress'}});
  }
  if(r.method==='turn/steer'){
   fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({app,text:r.params.input[0].text,id:r.params.clientUserMessageId})+'\\n');
   out({id:r.id,result:{turnId:'native-turn'}});
   notify('item/completed',{turnId:'native-turn',item:{id:'reply-'+(++n),type:'agentMessage',text:'received'}});
   if(r.params.input[0].text.includes('FINISH'))notify('turn/completed',{turn:{id:'native-turn',status:'completed'}});
  }
 } else if(r.type==='user'){
  const text=r.message.content[0].text;
  if(n++===0)return out({type:'system',subtype:'init',session_id:${JSON.stringify(claudeId)}});
  fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({app,text})+'\\n');
  out({type:'assistant',message:{id:'reply-'+n,role:'assistant',content:[{type:'text',text:'received'}]}});
  if(text.includes('FINISH'))out({type:'result',subtype:'success',session_id:${JSON.stringify(claudeId)}});
 }
});
`);
await fs.chmod(fake, 0o755); Object.assign(process.env, { CC_WEBUI_CLAUDE_BIN: fake, CC_WEBUI_CODEX_BIN: fake });
const { createUser, setAllowedProviders } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { setShares } = await import("./auth/sharing.ts");
const { createApp } = await import("./app.ts");
const { resolveMemoryScope } = await import("./project-memory/scope.ts");
const { saveMemory } = await import("./project-memory/store.ts");
const { closeDb } = await import("./db.ts");
const { getCodexSessionTurns } = await import("./session-store.ts");
try {
  const owner = createUser({ username: "owner", password: "pw", role: "user", allowedPaths: [tmp] });
  const reader = createUser({ username: "reader", password: "pw", role: "user", allowedPaths: [tmp] });
  const stranger = createUser({ username: "stranger", password: "pw", role: "user", allowedPaths: [tmp] });
  for (const u of [owner, reader, stranger]) setAllowedProviders(u.id, ["claude", "codex"]);
  const headers = (id = owner.id) => ({ cookie: `${SESSION_COOKIE}=${issueSession(id)}`, "content-type": "application/json" });
  const app = createApp();
  const scope = await resolveMemoryScope(owner.id, tmp);
  await saveMemory(scope, { operation_id: "seed", name: "rule", description: "STEER_INDEX", type: "feedback", body: "BODY_ONLY_VIA_READ" }, { provider: "claude", sessionId: "" });
  for (const provider of ["claude", "codex"] as const) {
    const base = provider === "codex" ? "/api/codex/chat" : "/api/chat";
    const sessionId = provider === "codex" ? codexId : claudeId;
    // No browser-local turn ID: the server supplies a strict steering target.
    const res = await app.request(base, { method: "POST", headers: headers(), body: JSON.stringify({ cwd: tmp, prompt: "initial", permissionMode: "auto" }) });
    assert.equal(res.status, 200);
    const stream = res.body!.getReader(), decoder = new TextDecoder(); let text = "";
    // Read through identity, not just availability (the handle can be exposed
    // before the first native thread frame has been consumed by the route).
    while (!text.includes(sessionId) || !text.includes('"available":true') || !text.includes('"canSteer":true')) {
      const data = await stream.read(); assert(!data.done); text += decoder.decode(data.value);
    }
    const target = JSON.parse(text.match(/data: (\{"type":"steer_target"[^\n]+\})/)![1]);
    assert.equal(target.provider, provider); assert.equal(target.canSteer, true);
    assert.equal(target.ownerId, undefined, "connection capability does not expose the running actor");
    const clientTurnId = target.clientTurnId;
    assert.equal(typeof clientTurnId, "string");
    const payload: { sessionId: string; clientTurnId: string; messageId: string; text: string } = { sessionId, clientTurnId, messageId: `q-${provider}`, text: "feedback" };
    const steer = (body = payload, id = owner.id) => app.request(base + "/steer", { method: "POST", headers: headers(id), body: JSON.stringify(body) });
    assert.equal((await steer({ ...payload, clientTurnId: "wrong-turn" })).status, 409);
    assert.equal((await steer(payload, stranger.id)).status, 404);
    setShares({ resourceId: sessionId, kind: provider, userIds: [reader.id], sharedBy: owner.id, ownerId: owner.id });
    assert.equal((await steer(payload, reader.id)).status, 409, "reader must wait for their own turn, not inherit the running actor's tools");
    assert.equal((await steer()).status, 200);
    assert.equal((await steer()).status, 200, "HTTP retry is idempotent while the turn is running");
    assert.equal((await steer({ ...payload, text: "different" })).status, 400);
    const replay = await app.request(base + `/attach?sessionId=${sessionId}&clientTurnId=${clientTurnId}`, { headers: headers(reader.id) });
    assert.equal(replay.status, 200); const replayText = replay.text();
    const ownReplay = await app.request(base + `/attach?sessionId=${sessionId}`, { headers: headers() });
    assert.equal(ownReplay.status, 200); const ownReplayText = ownReplay.text();
    assert.equal((await steer({ ...payload, messageId: `finish-${provider}`, text: "FINISH" })).status, 200);
    const replayed = await replayText;
    assert.match(replayed, /"canSteer":false/, "shared viewer is not offered the actor's steering capability");
    assert.match(await ownReplayText, /"canSteer":true/, "same account can steer from another tab with no local ActiveTurn");
    assert.equal((replayed.match(new RegExp(`"id":"u-steer-q-${provider}"`, "g")) ?? []).length, 1);
    assert(replayed.indexOf(`"id":"u-steer-q-${provider}"`) < replayed.indexOf('"text":"received"'), "accepted input precedes output caused by it");
    while (true) { const data = await stream.read(); if (data.done) break; text += decoder.decode(data.value); }
    assert.match(text, /event: done/);
    const records = (await fs.readFile(capture, "utf8")).trim().split("\n").map(l => JSON.parse(l)).filter(r => r.app === (provider === "codex"));
    assert.equal(records.length, 2, "retry must not inject another native message");
    assert.match(records[0].text, /STEER_INDEX/); assert.doesNotMatch(records[0].text, /BODY_ONLY_VIA_READ/);
  }
  const stored = await getCodexSessionTurns(codexId);
  assert.equal(stored[0].events.filter((e: any) => e.type === "steer_user").length, 2, "DB fallback preserves added inputs");
  console.log("chat-steering.test.ts: both providers accept, scope and replay steering correctly");
} finally { closeDb(); await fs.rm(tmp, { recursive: true, force: true }); }
