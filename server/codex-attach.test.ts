import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-codex-attach-"));
Object.assign(process.env, {
  CC_WEBUI_DB: path.join(tmp, "test.db"),
  CC_WEBUI_WORKSPACES_DIR: path.join(tmp, "workspaces"),
  CC_WEBUI_GROUPS_DIR: path.join(tmp, "groups"),
  CC_WEBUI_CLAUDE_PROJECTS_DIR: path.join(tmp, "claude"),
  CODEX_SESSIONS_DIR: path.join(tmp, "codex"),
  CC_WEBUI_COOKIE_SECRET_FILE: path.join(tmp, "cookie"),
  CC_WEBUI_PROJECT_MEMORY_ENABLED: "0",
});
const sessionId = randomUUID();
const clientTurnId = randomUUID();
const release = path.join(tmp, "release");
const fake = path.join(tmp, "codex.cjs");
await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const out = o => process.stdout.write(JSON.stringify(o)+'\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({type:'thread.started',thread_id:${JSON.stringify(sessionId)}});
  out({type:'turn.started'});
  out({type:'item.started',item:{id:'item_2',type:'command_execution',command:'echo ok',status:'in_progress'}});
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    out({type:'item.completed',item:{id:'item_2',type:'command_execution',command:'echo ok',status:'completed',aggregated_output:'ok'}});
    out({type:'item.completed',item:{id:'item_3',type:'agent_message',text:'finished'}});
    out({type:'turn.completed'});
  }, 20);
});
`);
await fs.chmod(fake, 0o755);
process.env.CC_WEBUI_CODEX_BIN = fake;
const { createUser, setAllowedProviders } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");
const { createApp } = await import("./app.ts");
const { getCodexSessionTurns } = await import("./session-store.ts");
const { closeDb } = await import("./db.ts");
const { applySDKMessage, sessionMessagesToEvents } = await import("../src/lib/processor.ts");
const { showCodexActivity, liveToolIds } = await import("../src/lib/turn-activity.ts");
import type { ChatEvent } from "../src/lib/types.ts";

try {
  const sender = createUser({ username: "sender", password: "pw", role: "user", allowedPaths: [tmp] });
  const viewer = createUser({ username: "viewer", password: "pw", role: "admin", allowedPaths: [tmp] });
  const stranger = createUser({ username: "stranger", password: "pw", role: "user", allowedPaths: [tmp] });
  setAllowedProviders(sender.id, ["claude", "codex"]);
  const headers = (id: string) => ({ cookie: `${SESSION_COOKIE}=${issueSession(id)}`, "content-type": "application/json" });
  const app = createApp();
  const prompt = "本轮的新问题\n不要显示上一轮的回复";
  const image = { mediaType: "image/png", data: "aW1hZ2U=", name: "screenshot.png" };
  const res = await app.request("/api/codex/chat", {
    method: "POST", headers: headers(sender.id),
    body: JSON.stringify({ cwd: tmp, prompt, clientTurnId, permissionMode: "auto", effort: "xhigh", images: [image] }),
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let prefix = "";
  while (!prefix.includes('"item.started"')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    prefix += decoder.decode(chunk.value);
  }
  const frames = prefix.split("\n\n").filter(Boolean).map(block => ({
    event: block.split("\n").find(l => l.startsWith("event:"))!.slice(7),
    data: JSON.parse(block.split("\n").find(l => l.startsWith("data:"))!.slice(6)),
  }));
  assert.equal(frames[0].event, "turn_meta");
  assert.equal(frames[1].event, "turn_user", "question is buffered before any CLI output");
  assert.equal(frames[1].data.prompt, prompt);
  assert.equal(frames[1].data.startedAt, frames[0].data.startedAt);
  assert.deepEqual(frames[1].data.images, [image]);

  // An authorized viewer has no sender-local ActiveTurn. Only SSE replay can
  // recover the current question while the completed-turn store is empty.
  assert.equal((await getCodexSessionTurns(sessionId)).length, 0);
  const attach = await app.request(`/api/codex/chat/attach?sessionId=${sessionId}`, { headers: headers(viewer.id) });
  assert.equal(attach.status, 200);
  const replay = attach.text();
  const denied = await app.request(`/api/codex/chat/attach?sessionId=${sessionId}`, { headers: headers(stranger.id) });
  assert.equal(denied.status, 404, "buffered prompt is not exposed to an unauthorized reader");
  await fs.writeFile(release, "");
  const text = await replay;
  assert.match(text, /event: done/);
  let events: ChatEvent[] = [];
  for (const block of text.split("\n\n")) {
    const data = block.split("\n").find(l => l.startsWith("data: "))?.slice(6);
    if (data) events = applySDKMessage(events, JSON.parse(data), () => {});
  }
  assert.deepEqual(events.filter(e => e.type === "user").map(e => e.text), [prompt]);
  assert.deepEqual(events.filter(e => e.type === "user").map(e => e.images), [[image]], "another authorized tab recovers the image from SSE replay");
  assert.deepEqual(events.filter(e => e.type === "assistant").map(e => e.text), ["finished"]);
  assert.equal(showCodexActivity(events, false), false, "done stops activity");
  assert.deepEqual([...liveToolIds(events, false)], []);
  while (!(await reader.read()).done) { /* drain initiating stream */ }
  const stored = await getCodexSessionTurns(sessionId);
  assert.equal(stored[0].prompt, prompt);
  assert.equal(stored[0].startedAt, frames[1].data.startedAt);
  const reopened = sessionMessagesToEvents(stored);
  assert.deepEqual(reopened.filter(e => e.type === "user").map(e => e.images), [[image]], "completed history persists images even when no native rollout exists");
  assert.deepEqual(reopened.filter(e => e.type === "assistant").map(e => e.text), ["finished"], "persisted control envelope does not duplicate replies");
  const historyPath = `/api/sessions/${sessionId}/messages?provider=codex&cwd=${encodeURIComponent(tmp)}`;
  const history = await app.request(historyPath, { headers: headers(viewer.id) });
  assert.equal(history.status, 200);
  assert.match(await history.text(), /aW1hZ2U=/);
  assert.equal((await app.request(historyPath, { headers: headers(stranger.id) })).status, 404, "durable attachment bytes remain session-authorized");
} finally {
  await fs.writeFile(release, "").catch(() => {});
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log("Codex attach replays the current question to authorized viewers");
