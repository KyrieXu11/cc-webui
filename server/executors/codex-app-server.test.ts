import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecOptions, ExecResult, SteerSend } from "./types.ts";
import { codexAppServerExecutor, appThreadParams, assertThreadPolicy, buildAppServerArgs } from "./codex-app-server.ts";
import { CODEX_ARTIFACT_PLUGIN_OVERRIDES } from "../codex-plugin-policy.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-app-steer-"));
const capture = path.join(dir, "capture.jsonl"), bin = path.join(dir, "fake.cjs");
const old = process.env.CC_WEBUI_CODEX_BIN;
await fs.writeFile(bin, `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const emit=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const result=(id,r)=>emit({id,result:r});let prompt='';
const notify=(method,params)=>emit({method,params:{threadId:'thread-1',...params}});
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),token:process.env.CC_WEBUI_MCP_TOKEN_BASH})+'\\n');
rl.on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(r)+'\\n');
 if(r.method==='initialize')return result(r.id,{});
 if(r.method==='thread/start')return result(r.id,{thread:{id:'thread-1'}});
 if(r.method==='thread/resume'){
  if(r.params.excludeTurns!==true)notify('deprecationNotice',{summary:'Full-history hydration is deprecated for paginated threads; use excludeTurns: true'});
  if(r.params.threadId==='missing')return emit({id:r.id,error:{code:-32600,message:'no rollout found for thread missing'}});
  return result(r.id,{thread:{id:r.params.threadId}});
 }
 if(r.method==='turn/start'){
  prompt=r.params.input[0].text;
  result(r.id,{turn:{id:'turn-1',status:'inProgress'}});
  notify('turn/started',{turn:{id:'turn-1',status:'inProgress'}});
  notify('item/started',{turnId:'turn-1',item:{id:'cmd-1',type:'commandExecution',command:'echo test',status:'inProgress'}});
  if(prompt==='approval'){
   emit({id:'host-approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1'}});
   emit({id:'unknown',method:'unsupported/secret',params:{}});
  }
  if(prompt==='notice')notify('configWarning',{summary:'Synthetic warning',details:'Retain this warning'});
  if(prompt.startsWith('retry-')){
   notify('error',{turnId:'turn-1',willRetry:true,error:{message:'Reconnecting... 1/5',additionalDetails:'websocket closed by server before response.completed',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:503}}}});
   // Closing an old item does not mean the model has reconnected.
   notify('item/completed',{turnId:'turn-1',item:{id:'cmd-1',type:'commandExecution',command:'echo test',status:'completed'}});
   if(prompt==='retry-success')setTimeout(()=>{
    notify('item/started',{turnId:'turn-1',item:{id:'new-reason',type:'reasoning',summary:[]}});
    notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
   },20);
   if(prompt==='retry-fatal')setTimeout(()=>{
    notify('error',{turnId:'turn-1',willRetry:false,error:{message:'No more attempts'}});
    notify('turn/completed',{turn:{id:'turn-1',status:'failed',error:{message:'No more attempts'}}});
   },20);
  }
  if(['finish','approval','notice'].includes(prompt))setTimeout(()=>notify('turn/completed',{turn:{id:'turn-1',status:'completed'}}),20);
 }
 if(r.method==='turn/steer'){
  if(r.params.expectedTurnId!=='turn-1')throw Error('wrong optimistic lock');
  if(prompt==='late-ack'){
   notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
   return setTimeout(()=>result(r.id,{turnId:'turn-1'}),50);
  }
  if(prompt==='wrong-ack'){
   result(r.id,{turnId:'unexpected-turn'});
   return notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
  }
  if(prompt==='rejected')emit({id:r.id,error:{code:-32600,message:'no active turn on thread'}});
  else {
   result(r.id,{turnId:'turn-1'});
   notify('item/started',{turnId:'turn-1',item:{type:'userMessage',id:'native-user',content:r.params.input}});
   notify('item/agentMessage/delta',{turnId:'turn-1',itemId:'answer-1',delta:r.params.input[0].text});
   notify('item/completed',{turnId:'turn-1',item:{id:'cmd-1',type:'commandExecution',command:'echo test',status:'completed',aggregatedOutput:'ok',exitCode:0}});
  }
  notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
 }
 if(r.method==='turn/interrupt'){
  result(r.id,{});notify('turn/completed',{turn:{id:'turn-1',status:'interrupted'}});
 }
});
`);
await fs.chmod(bin, 0o755); process.env.CC_WEBUI_CODEX_BIN = bin;
const base = (extra: Partial<ExecOptions> = {}): ExecOptions => ({ cwd: dir, prompt: "initial", signal: new AbortController().signal,
  mode: "auto", effort: "ultra", disableNativeMemory: true, mcpServers: [{ name: "bash", url: "http://127.0.0.1:1/api/mcp/bash", bearerToken: "FAKE_GATEWAY_SECRET" }], ...extra });
try {
  const args = buildAppServerArgs(base());
  assert.equal(args[0], "app-server");
  for (const override of [...CODEX_ARTIFACT_PLUGIN_OVERRIDES, 'service_tier="default"', 'features.fast_mode=false',
    'approval_policy="on-request"', 'approvals_reviewer="auto_review"', 'model_reasoning_effort="ultra"', 'features.memories=false']) assert(args.includes(override), override);
  assert(!args.join(" ").includes("FAKE_GATEWAY_SECRET"));
  assert.equal(appThreadParams(base({ mode: "plan" })).sandbox, "read-only");
  assert.equal(appThreadParams(base({ mode: "plan" })).approvalPolicy, "never");
  assert.throws(() => assertThreadPolicy({ sandbox: { type: "workspaceWrite" } }, base({ mode: "plan" })), /sandbox/);
  assert.throws(() => assertThreadPolicy({ serviceTier: "fast" }, base()), /Fast/);
  assert.throws(() => assertThreadPolicy({ approvalPolicy: "on-request", approvalsReviewer: "user" }, base()), /Auto-review/);

  let handle: SteerSend | null = null, accepted: boolean | undefined, revoked = false;
  const read = () => handle;
  const raw: any[] = [];
  let ended: ExecResult | undefined;
  const acceptedFrame = (id: string) => ({ type: "steer_user" as const, id: `u-steer-${id}`, text: "accepted text", provider: "codex" as const });
  for await (const f of codexAppServerExecutor.exec(base({ onSteerAccepted: acceptedFrame, onSteer: send => { handle = send; if (!send) revoked = true; } }))) {
    if (f.kind === "ended") { ended = f.result; continue; }
    const frame = f.payload as any; raw.push(frame);
    if (frame.type === "turn.started") accepted = await read()!("change direction", "q-first");
  }
  assert.equal(accepted, true, "success requires a native turn/steer ACK");
  assert.equal(ended?.status, "completed"); assert.equal(ended?.sessionHandle, "thread-1");
  assert(revoked); assert.equal(read(), null);
  assert(raw.some(r => r.type === "codex_delta" && r.delta === "change direction"));
  assert(raw.some(r => r.item?.id === "cmd-1" && r.type === "item.completed" && r.turn_id === "turn-1"));
  assert(!raw.some(r => r.item?.type === "userMessage"), "native input echo must not duplicate the route's accepted user frame");
  assert(raw.findIndex(r => r.item?.id === "cmd-1") < raw.findIndex(r => r.type === "steer_user"), "an accepted input must not overtake native frames already queued");
  assert(raw.findIndex(r => r.type === "steer_user") < raw.findIndex(r => r.type === "codex_delta"));

  let late: Promise<boolean> | undefined;
  const lateFrames: any[] = [];
  for await (const f of codexAppServerExecutor.exec(base({ prompt: "late-ack", onSteerAccepted: acceptedFrame, onSteer: send => { handle = send; } }))) {
    if (f.kind === "raw") {
      lateFrames.push(f.payload);
      if ((f.payload as any).type === "turn.started") {
        late = Promise.resolve(read()!("feedback", "q-late-ack"));
        void late.catch(() => {});
      }
    } else assert.equal(f.result.status, "completed");
  }
  assert.equal(await late, true, "completion before the native ACK must not close the response pipe");
  assert(lateFrames.some(f => f.id === "u-steer-q-late-ack"), "acknowledged input is drained before persistence");

  for await (const f of codexAppServerExecutor.exec(base({ prompt: "wrong-ack", onSteer: send => { handle = send; } }))) {
    if (f.kind === "raw" && (f.payload as any).type === "turn.started") await assert.rejects(Promise.resolve(read()!("feedback", "q-wrong-ack")), /unexpected.*acknowledgement/);
  }

  let rejected: boolean | undefined;
  for await (const f of codexAppServerExecutor.exec(base({ prompt: "rejected", onSteer: send => { handle = send; } }))) {
    if (f.kind === "raw" && (f.payload as any).type === "turn.started") rejected = await read()!("late", "q-late");
  }
  assert.equal(rejected, false, "ended native turn falls back without pretending it accepted input");

  const abort = new AbortController();
  for await (const f of codexAppServerExecutor.exec(base({ prompt: "abort", signal: abort.signal }))) {
    if (f.kind === "raw" && (f.payload as any).type === "turn.started") abort.abort();
    if (f.kind === "ended") assert.equal(f.result.status, "aborted");
  }
  for await (const f of codexAppServerExecutor.exec(base({ resume: "missing" }))) if (f.kind === "ended") {
    assert.equal(f.result.sessionNotFound, true); assert.equal(f.result.sessionHandle, undefined);
  }
  for await (const _f of codexAppServerExecutor.exec(base({ prompt: "approval" }))) { /* consume */ }
  const notices: any[] = [];
  for await (const f of codexAppServerExecutor.exec(base({ prompt: "notice" }))) if (f.kind === "raw") notices.push(f.payload);
  assert(notices.some(f => f.item?.notice && f.item.message.includes("Retain this warning")));
  for (const prompt of ["retry-success", "retry-fatal", "retry-abort"]) {
    const frames: any[] = [], stop = new AbortController();
    let result: ExecResult | undefined;
    for await (const f of codexAppServerExecutor.exec(base({ prompt, signal: stop.signal }))) {
      if (f.kind === "ended") result = f.result;
      else {
        frames.push(f.payload);
        if (prompt === "retry-abort" && (f.payload as any).type === "codex_retry") stop.abort();
      }
    }
    const controls = frames.filter(f => f.type === "codex_retry");
    assert.deepEqual(controls.map(f => f.status), ["retrying", prompt === "retry-success" ? "resumed" : "ended"]);
    assert.equal(controls[0].details, "websocket closed by server before response.completed");
    assert.equal(controls[0].httpStatusCode, 503); assert.equal(controls[0].attempt, undefined);
    assert.equal(result?.status, prompt === "retry-success" ? "completed" : prompt === "retry-fatal" ? "failed" : "aborted");
    if (prompt === "retry-fatal") assert(frames.some(f => f.type === "error" && f.message === "No more attempts"), "terminal error remains visible");
  }
  for await (const f of codexAppServerExecutor.exec(base({ prompt: "timeout", timeoutMs: 120 }))) if (f.kind === "ended") assert.equal(f.result.status, "timeout");
  const resumedFrames: any[] = [];
  for await (const f of codexAppServerExecutor.exec(base({ prompt: "finish", resume: "thread-1", mode: "plan",
    images: [{ mediaType: "image/png", data: Buffer.from("synthetic").toString("base64") }] }))) {
    if (f.kind === "raw") resumedFrames.push(f.payload);
    else assert.equal(f.result.sessionHandle, "thread-1");
  }
  assert(!JSON.stringify(resumedFrames).includes("Full-history hydration"), "resume must avoid triggering the warning, not filter it after receipt");
  const records = (await fs.readFile(capture, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert(records.some(r => r.token === "FAKE_GATEWAY_SECRET"));
  assert(records.filter(r => r.method === "thread/resume").every(r => r.params.excludeTurns === true), "every resume requests only response metadata");
  assert(records.filter(r => r.method === "thread/start").every(r => r.params.excludeTurns === undefined), "excludeTurns belongs to resume, not new-thread creation");
  const steer = records.find(r => r.method === "turn/steer");
  assert.equal(steer.params.expectedTurnId, "turn-1"); assert.equal(steer.params.clientUserMessageId, "q-first");
  assert.deepEqual(records.find(r => r.id === "host-approval" && r.result)?.result, { decision: "decline" });
  assert.equal(records.find(r => r.id === "unknown" && r.error)?.error.code, -32601);
  const image = records.find(r => r.method === "turn/start" && r.params.input.length > 1)?.params.input[1];
  assert.equal(image.type, "localImage"); await assert.rejects(fs.stat(image.path), /ENOENT/);
  process.env.CC_WEBUI_CODEX_BIN = path.join(dir, "does-not-exist");
  for await (const f of codexAppServerExecutor.exec(base())) if (f.kind === "ended") {
    assert.equal(f.result.status, "failed"); assert.match(f.result.error!, /ENOENT/);
  }
  console.log("codex-app-server.test.ts: all assertions passed");
} finally {
  if (old === undefined) delete process.env.CC_WEBUI_CODEX_BIN; else process.env.CC_WEBUI_CODEX_BIN = old;
  await fs.rm(dir, { recursive: true, force: true });
}
