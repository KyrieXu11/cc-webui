import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { WEB_OUTPUT_RULES } from "./web-output-rules.ts";
import { CODEX_ARTIFACT_PLUGIN_OVERRIDES, CODEX_ARTIFACT_PLUGIN_PROMPT } from "./codex-plugin-policy.ts";
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-memory-turn-"));
Object.assign(process.env, {
  CC_WEBUI_DB: path.join(tmp, "db"),
  CC_WEBUI_PROJECT_MEMORY_DIR: path.join(tmp, "memory"),
  CC_WEBUI_WORKSPACES_DIR: path.join(tmp, "workspaces"),
  CC_WEBUI_GROUPS_DIR: path.join(tmp, "groups"),
  CC_WEBUI_SESSION_INDEX: path.join(tmp, "index"),
  CC_WEBUI_CLAUDE_PROJECTS_DIR: path.join(tmp, "claude"),
  CODEX_SESSIONS_DIR: path.join(tmp, "codex"),
  CC_WEBUI_COOKIE_SECRET_FILE: path.join(tmp, "cookie"),
  CC_WEBUI_DOTENV: path.join(tmp, "empty.env"),
  CC_WEBUI_PROJECT_MEMORY_ENABLED: "1"
});
await fs.writeFile(process.env.CC_WEBUI_DOTENV!, "");
const capture = path.join(tmp, "captures.jsonl");
const fake = path.join(tmp, "cli.cjs");
await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const codex = process.argv.includes('exec');
const out = o => process.stdout.write(JSON.stringify(o)+'\\n');
const finish = prompt => {
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({codex, prompt, args:process.argv.slice(2), nativeDisabled:process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY})+'\\n');
  if(codex) {
    out({type:'thread.started',thread_id:'22222222-2222-4222-8222-222222222222'});
    out({type:'item.completed',item:{id:'a',type:'agent_message',text:'ok'}});
    out({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
  } else {
    out({type:'system',subtype:'init',session_id:'11111111-1111-4111-8111-111111111111',model:'opus'});
    out({type:'assistant',message:{id:'a',role:'assistant',content:[{type:'text',text:'ok'}]}});
    out({type:'result',subtype:'success',session_id:'11111111-1111-4111-8111-111111111111'});
  }
};
if(codex) { let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>finish(s)); }
else { let done=false;require('node:readline').createInterface({input:process.stdin}).on('line',s=>{if(!done){done=true;finish(JSON.parse(s).message.content[0].text)}}); }
`);
await fs.chmod(fake, 0o755);
process.env.CC_WEBUI_CLAUDE_BIN = fake;
process.env.CC_WEBUI_CODEX_BIN = fake;
const {
  createUser,
  setAllowedProviders
} = await import("./auth/users.ts");
const {
  issueSession,
  SESSION_COOKIE
} = await import("./auth/session.ts");
const {
  resolveMemoryScope
} = await import("./project-memory/scope.ts");
const {
  saveMemory,
  listMemory
} = await import("./project-memory/store.ts");
const {
  memoryPrompt
} = await import("./project-memory/prompt.ts");
const {
  createApp
} = await import("./app.ts");
const {
  closeDb
} = await import("./db.ts");
const {
  unwrapMemoryPrompt
} = await import("../shared/project-memory-envelope.ts");
const { projectSlug } = await import("./claude-sessions.ts");
try {
  const user = createUser({
    username: "member",
    password: "pw",
    role: "user",
    allowedPaths: [tmp]
  });
  setAllowedProviders(user.id, ["claude", "codex"]);
  const scope = await resolveMemoryScope(user.id, tmp);
  await saveMemory(scope, {
    operation_id: "seed",
    name: "project-test",
    description: "INDEX_SENTINEL",
    type: "project",
    body: "BODY_SENTINEL_DO_NOT_AUTO_INJECT"
  }, {
    provider: "claude",
    sessionId: ""
  });
  const app = createApp();
  const send = async (provider: "claude" | "codex", permissionMode = "auto", sessionId?: string) => {
    const res = await app.request(provider === "claude" ? "/api/chat" : "/api/codex/chat", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE}=${issueSession(user.id)}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        cwd: tmp,
        prompt: "hello",
        clientTurnId: randomUUID(),
        permissionMode,
        sessionId
      })
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /ok/);
    if (provider === "codex") {
      const first = text.split("\n\n")[0];
      assert.match(first, /^event: turn_meta/);
      const meta = JSON.parse(first.split("\n").find(line => line.startsWith("data:"))!.slice(5));
      assert.equal(meta.provider, "codex"); assert.equal(meta.effort, null);
      assert.ok(Number.isFinite(meta.startedAt));
    }
  };
  await send("claude");
  await send("codex");
  const records = (await fs.readFile(capture, "utf8")).trim().split("\n").map(s => JSON.parse(s));
  const claude = records.find(r => !r.codex),
    codex = records.find(r => r.codex);
  for (const r of records) {
    assert.match(r.prompt, /INDEX_SENTINEL/);
    assert.doesNotMatch(r.prompt, /BODY_SENTINEL_DO_NOT_AUTO_INJECT/);
    assert.equal(unwrapMemoryPrompt(r.prompt).trim(), "hello");
    assert.ok(r.codex ? r.prompt.includes(WEB_OUTPUT_RULES) : r.args.some((a: string) => a.includes(WEB_OUTPUT_RULES)), "both providers receive web output rules with memory enabled");
  }
  assert.equal(claude.nativeDisabled, "1");
  assert.ok(claude.args.includes(memoryPrompt(true)) || claude.args.some((a: string) => a.endsWith(memoryPrompt(true))));
  assert.match(claude.args[claude.args.indexOf("--mcp-config") + 1], /"memory"/);
  assert.ok(codex.args.includes("features.memories=false"));
  assert.ok(codex.args.includes("memories.use_memories=false"));
  assert.ok(codex.args.some((s: string) => s.startsWith("mcp_servers.memory.url=")));
  assert.ok(!codex.args.some((s: string) => s.includes("Bearer ")), "Codex capability stays in env, not argv");
  assert.ok(codex.prompt.includes(memoryPrompt(true)), "same business rules for both providers");
  const expected = await fs.readFile(new URL("./project-memory/fixtures/prompt-v2-writable.txt", import.meta.url), "utf8");
  assert.ok(claude.args.some((a: string) => a.endsWith(expected)), "Claude receives the reviewed writable fixture in its system append");
  assert.ok(codex.prompt.includes(expected), "Codex receives the same reviewed writable fixture");

  // Next turns must reload the current metadata, not reuse the first snapshot.
  const old = (await listMemory(scope)).entries[0];
  await saveMemory(scope, {
    operation_id: "refresh-index", id: old.id, expected_revision: old.revision,
    name: old.name, description: "INDEX_REFRESH_SENTINEL", type: "project",
    body: "BODY_SENTINEL_DO_NOT_AUTO_INJECT"
  }, { provider: "codex", sessionId: "" });
  await send("claude", "plan");
  await send("codex", "plan");
  const plans = (await fs.readFile(capture, "utf8")).trim().split("\n").map(s => JSON.parse(s)).slice(-2);
  const readonly = await fs.readFile(new URL("./project-memory/fixtures/prompt-v2-readonly.txt", import.meta.url), "utf8");
  for (const r of plans) {
    assert.match(r.prompt, /INDEX_REFRESH_SENTINEL/);
    assert.doesNotMatch(r.prompt, /BODY_SENTINEL_DO_NOT_AUTO_INJECT/);
    assert.ok(r.codex ? r.prompt.includes(readonly) : r.args.some((a: string) => a.endsWith(readonly)), "both providers receive the same read-only fixture");
    assert.ok(r.codex ? r.prompt.includes(WEB_OUTPUT_RULES) : r.args.some((a: string) => a.includes(WEB_OUTPUT_RULES)), "Plan mode keeps web output rules without changing memory restrictions");
  }
  process.env.CC_WEBUI_PROJECT_MEMORY_ENABLED = "false";
  await send("claude");
  const last = JSON.parse((await fs.readFile(capture, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(last.prompt, "hello");
  assert.equal(last.nativeDisabled, undefined);
  assert.ok(last.args[last.args.indexOf("--append-system-prompt") + 1].includes(WEB_OUTPUT_RULES), "Claude also receives web output rules with memory disabled");
  assert.doesNotMatch(last.args[last.args.indexOf("--mcp-config") + 1], /"memory"/);
  await send("codex");
  const offCodex = JSON.parse((await fs.readFile(capture, "utf8")).trim().split("\n").at(-1)!);
  assert.doesNotMatch(offCodex.prompt, /project-memory-v2|project-memory-snapshot/);
  assert.ok(offCodex.prompt.includes(WEB_OUTPUT_RULES), "Codex also receives web output rules with memory disabled");
  assert.ok(!offCodex.args.includes("features.memories=false"));
  assert.ok(!offCodex.args.some((a: string) => a.startsWith("mcp_servers.memory.")), "feature-off restores native Codex behavior too");

  // 旧会话也必须收到本轮规范，不能只在首次创建时注入。假 CLI 不落 native
  // transcript，因此为 Claude 的 resume 存在性检查补一份隔离 fixture。
  const nativeDir = path.join(process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR!, projectSlug(tmp));
  await fs.mkdir(nativeDir, { recursive: true });
  await fs.writeFile(path.join(nativeDir, "11111111-1111-4111-8111-111111111111.jsonl"), JSON.stringify({
    type: "user", uuid: randomUUID(), cwd: tmp,
    message: { role: "user", content: "hello" },
  }) + "\n");
  await send("claude", "auto", "11111111-1111-4111-8111-111111111111");
  await send("codex", "auto", "22222222-2222-4222-8222-222222222222");
  const resumed = (await fs.readFile(capture, "utf8")).trim().split("\n").slice(-2).map(s => JSON.parse(s));
  for (const r of resumed) {
    assert.ok(r.args.includes(r.codex ? "resume" : "--resume"), "test actually resumes a native session");
    assert.ok(r.codex ? r.prompt.includes(WEB_OUTPUT_RULES) : r.args.some((a: string) => a.includes(WEB_OUTPUT_RULES)), "native resume receives current web output rules too");
  }
  for (const r of (await fs.readFile(capture, "utf8")).trim().split("\n").map(s => JSON.parse(s))) {
    if (r.codex) {
      for (const rule of CODEX_ARTIFACT_PLUGIN_OVERRIDES) {
        assert.equal(r.args[r.args.indexOf(rule) - 1], "--config", "PPT/PDF are disabled in every actual Codex spawn, with memory on/off or resume");
      }
      assert.ok(r.prompt.includes(CODEX_ARTIFACT_PLUGIN_PROMPT), "old skill text cannot silently revive the disabled workflow on resume");
    } else {
      assert.ok(!r.args.some((a: string) => CODEX_ARTIFACT_PLUGIN_OVERRIDES.includes(a)), "Claude invocation is unaffected");
      assert.ok(!r.prompt.includes(CODEX_ARTIFACT_PLUGIN_PROMPT));
    }
  }
} finally {
  closeDb();
  await fs.rm(tmp, {
    recursive: true,
    force: true
  });
}
console.log("managed-memory CLI turn adapters tested without real AI calls");
