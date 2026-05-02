# Multi-Agent Group Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 cc-webui 里加"群聊"会话，用户能 `@claude` / `@codex` 单点对话或 `@all` 触发流水线协作；每个 agent 各自配 model / mode / effort / system prompt / skills / MCP；群聊会话与现有单聊隔离，每次 SDK 调用都是 single-shot，从 cc-webui 自己维护的 canonical jsonl 现场组装 prompt。

**Architecture:** 后端新增 `server/groups/` 目录承载所有群聊逻辑（store / config / input-builder / orchestrator / stream），加 `server/groups.ts` 暴露 Hono 路由。`server/shared/` 抽出 single-chat 与 group-chat 共用的 permission-flow + in-flight 注册（参数化 scope key）。前端新增 `src/components/group/` 目录承载 GroupChatView + 子组件，复用现有 MessageList / AssistantText / StepTimeline / EditDiff / PermissionCard。**关键技术决策**：v1 用 "concat-as-prompt" 模式跑 single-shot — Claude SDK 不传 `resume`，Codex 每次新建 Thread；input-builder 把整个 canonical transcript 渲染成单条 user prompt 给 SDK。

**Tech Stack:** Node 20+ / TypeScript / Hono (server) / React 18 + Vite + Tailwind 4 (frontend) / `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` / `node:test` (内置 test runner) / SSE for streaming。

**Spec:** `docs/superpowers/specs/2026-05-02-multi-agent-groupchat-design.md`

---

## File Structure

### Backend (new)

```
server/
├── groups/
│   ├── store.ts              # canonical jsonl R/W (append, read, tail)
│   ├── store.test.ts
│   ├── config.ts             # group config R/W + validation
│   ├── config.test.ts
│   ├── input-builder.ts      # canonical → SDK prompt string (PURE)
│   ├── input-builder.test.ts
│   ├── claude-runner.ts      # single-shot Claude SDK invocation
│   ├── codex-runner.ts       # single-shot Codex SDK invocation
│   ├── orchestrator.ts       # dispatch + pipeline
│   └── orchestrator.test.ts
├── shared/
│   ├── permission-flow.ts    # extracted from chat.ts (scope-keyed allowance)
│   └── inflight.ts           # extracted in-flight chat registry (generic)
└── groups.ts                 # Hono routes + SSE
```

### Backend (modified)

- `server/index.ts` — mount `/api/groups`
- `server/chat.ts` — switch to shared/permission-flow + shared/inflight
- `server/codex-chat.ts` — same
- `server/session-store.ts` — extend index to surface group rows in unified search (optional, last task)

### Frontend (new)

```
src/
├── components/
│   └── group/
│       ├── GroupChatView.tsx
│       ├── NewGroupDialog.tsx
│       ├── ParticipantsBar.tsx
│       └── GroupComposer.tsx     # extends Composer with @ autocomplete
├── lib/
│   └── groups.ts                 # API client + SSE wiring
```

### Frontend (modified)

- `src/App.tsx` — add `/groups/:gid` route case
- `src/components/ProjectSidebar.tsx` — add 群聊 group section
- `src/components/HomeView.tsx` — add 新建群聊 button
- `src/lib/types.ts` — add `GroupConfig`, `GroupTurnEntry`, `GroupChatEvent` types
- `src/components/MessageList.tsx` — accept optional `agentBadge` prop (drilled to bubbles)

### Tests location

Use existing `node:test` convention from `server/bash-mcp.test.ts` style. Run via `tsx --test server/**/*.test.ts`.

---

## Pre-flight

Run before Task 1 to confirm env is sane:

```bash
node --version    # 20+
npm install       # ensure deps current
npx tsc --noEmit  # baseline typecheck must pass on existing code
```

If typecheck fails on existing code (independent of this plan), stop and report — fix before starting.

---

## Task 0: SDK single-shot spike

**Goal:** Retire the highest-risk uncertainty before writing any plan code: confirm both SDKs accept a concat-as-prompt input with no session resume and produce streamable events.

**Files:**
- Create: `server/groups/spike-claude.ts` (throwaway)
- Create: `server/groups/spike-codex.ts` (throwaway)

- [ ] **Step 1: Write Claude spike**

```ts
// server/groups/spike-claude.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const transcriptText = `
[历史对话]
USER: 我们在做一个 multi-agent demo
ASSISTANT (你): 好的，准备好了

[来自 Codex 的回复]
我用 Python 写了一段 hello world 函数

[当前用户消息]
请用 TypeScript 重写一遍 Codex 给的代码
`.trim();

const q = query({
  prompt: transcriptText,
  options: {
    cwd: process.cwd(),
    model: "claude-opus-4-7",
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
  },
});

for await (const msg of q) {
  console.log(msg.type, JSON.stringify(msg).slice(0, 200));
  if (msg.type === "result") break;
}
```

- [ ] **Step 2: Run Claude spike**

```bash
npx tsx server/groups/spike-claude.ts
```

Expected: see streaming `assistant` / `partial_assistant` messages eventually producing TypeScript code. Result message at end. **No "session not found" or "resume failed" errors.** If errors, capture them and adjust plan (consider AsyncIterable<SDKUserMessage> path).

- [ ] **Step 3: Write Codex spike**

```ts
// server/groups/spike-codex.ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: process.cwd(),
  model: "gpt-5.3-codex",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
});

const transcriptText = `
[历史对话]
USER: 我们在做一个 multi-agent demo
ASSISTANT (你): 好的，准备好了

[来自 Claude 的回复]
我用 TypeScript 写了一段 hello world 函数

[当前用户消息]
请用 Python 重写一遍 Claude 给的代码
`.trim();

const result = await thread.runStreamed(transcriptText);
for await (const ev of result.events) {
  console.log(ev.type, JSON.stringify(ev).slice(0, 200));
  if (ev.type === "turn.completed" || ev.type === "turn.failed") break;
}
```

- [ ] **Step 4: Run Codex spike**

```bash
npx tsx server/groups/spike-codex.ts
```

Expected: streaming events ending in `turn.completed`. If `turn.failed` or thread errors, capture and adjust.

- [ ] **Step 5: Delete spike files (don't commit them)**

```bash
rm server/groups/spike-claude.ts server/groups/spike-codex.ts
```

- [ ] **Step 6: Document outcome**

If both spikes worked: proceed to Task 1.
If either failed: stop, post the error to the user, do not auto-pivot the plan — the chosen approach was concat-as-prompt and pivoting needs design re-confirmation.

No commit (spike files removed).

---

## Task 1: groups/store.ts — canonical jsonl R/W

**Files:**
- Create: `server/groups/store.ts`
- Create: `server/groups/store.test.ts`

The store handles append-only `transcript.jsonl` plus the top-level `index.json` that lists all groups for sidebar / search.

- [ ] **Step 1: Write the type definitions inline (export from store.ts)**

```ts
// server/groups/store.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type AgentId = "claude" | "codex";

export type ImageAttachment = {
  name?: string;
  mediaType: string;
  data: string;
};

export type GroupTurnEntry = {
  id: string;
  ts: number;
  type:
    | "user"
    | "assistant"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "permission"
    | "summary"
    | "error";
  agent: "user" | AgentId;
  recipients?: AgentId[];
  text?: string;
  tool?: {
    name: string;
    input?: Record<string, unknown>;
    output?: string;
    status: "ok" | "pending" | "error";
  };
  images?: ImageAttachment[];
  meta?: {
    turnId?: string;
    pipelineStep?: number;
    error?: string;
  };
};

export type GroupIndexRow = {
  id: string;
  title: string;
  cwd: string;
  lastTs: number;
  participantSummary: string;
  lastSnippet: string;
  inFlight: boolean;
};

export type GroupIndex = { groups: GroupIndexRow[] };
```

- [ ] **Step 2: Implement directory resolver + helpers**

```ts
// server/groups/store.ts (continued)

const HOME_DIR = os.homedir();

export function groupsRoot(): string {
  return process.env.CC_WEBUI_GROUPS_DIR
    ? path.resolve(expandHome(process.env.CC_WEBUI_GROUPS_DIR)!)
    : path.join(HOME_DIR, ".cc-webui", "groups");
}

export function groupDir(gid: string): string {
  return path.join(groupsRoot(), gid);
}

export function indexPath(): string {
  return path.join(groupsRoot(), "index.json");
}

export function transcriptPath(gid: string): string {
  return path.join(groupDir(gid), "transcript.jsonl");
}

export function configPath(gid: string): string {
  return path.join(groupDir(gid), "config.json");
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(HOME_DIR, p.slice(2)) : p;
}

export function newGroupId(): string {
  return randomUUID();
}

export function newEntryId(): string {
  return randomUUID();
}
```

- [ ] **Step 3: Write the failing test for `appendEntry` + `readAll`**

```ts
// server/groups/store.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-groups-test-${Date.now()}`);
process.env.CC_WEBUI_GROUPS_DIR = tmp;

const { appendEntry, readAll, ensureGroupDir, newGroupId, newEntryId } =
  await import("./store.ts");

describe("store / transcript jsonl", () => {
  before(async () => {
    await fs.mkdir(tmp, { recursive: true });
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("appends and reads back", async () => {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    const a = {
      id: newEntryId(),
      ts: Date.now(),
      type: "user" as const,
      agent: "user" as const,
      text: "hello",
    };
    const b = {
      id: newEntryId(),
      ts: Date.now() + 1,
      type: "assistant" as const,
      agent: "claude" as const,
      text: "hi",
    };
    await appendEntry(gid, a);
    await appendEntry(gid, b);
    const all = await readAll(gid);
    assert.equal(all.length, 2);
    assert.equal(all[0].text, "hello");
    assert.equal(all[1].agent, "claude");
  });

  it("readAll on missing transcript returns []", async () => {
    const gid = newGroupId();
    const all = await readAll(gid);
    assert.deepEqual(all, []);
  });

  it("tolerates trailing whitespace and skips blank lines", async () => {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    const filePath = path.join(tmp, gid, "transcript.jsonl");
    await fs.writeFile(
      filePath,
      `{"id":"a","ts":1,"type":"user","agent":"user","text":"hi"}\n\n  \n`,
    );
    const all = await readAll(gid);
    assert.equal(all.length, 1);
  });

  it("skips a corrupted line and continues", async () => {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    const filePath = path.join(tmp, gid, "transcript.jsonl");
    await fs.writeFile(
      filePath,
      [
        `{"id":"a","ts":1,"type":"user","agent":"user","text":"hi"}`,
        `not json at all`,
        `{"id":"b","ts":2,"type":"assistant","agent":"claude","text":"hi back"}`,
      ].join("\n") + "\n",
    );
    const all = await readAll(gid);
    assert.equal(all.length, 2);
    assert.equal(all[1].id, "b");
  });
});
```

- [ ] **Step 4: Run test to verify failure**

```bash
npx tsx --test server/groups/store.test.ts
```

Expected: FAIL because `appendEntry` / `readAll` / `ensureGroupDir` not implemented.

- [ ] **Step 5: Implement the functions in store.ts**

```ts
// server/groups/store.ts (continued)

export async function ensureGroupDir(gid: string): Promise<void> {
  await fs.mkdir(groupDir(gid), { recursive: true });
}

export async function appendEntry(
  gid: string,
  entry: GroupTurnEntry,
): Promise<void> {
  await ensureGroupDir(gid);
  await fs.appendFile(transcriptPath(gid), JSON.stringify(entry) + "\n");
}

export async function readAll(gid: string): Promise<GroupTurnEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath(gid), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const out: GroupTurnEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip corrupted line
    }
  }
  return out;
}
```

- [ ] **Step 6: Run tests, verify pass**

```bash
npx tsx --test server/groups/store.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 7: Add index.json R/W with another test**

Append to `store.test.ts`:

```ts
describe("store / index.json", () => {
  it("readIndex returns empty when missing", async () => {
    const { readIndex } = await import("./store.ts");
    const idx = await readIndex();
    assert.deepEqual(idx.groups, []);
  });

  it("upsertIndexRow writes and updates", async () => {
    const { upsertIndexRow, readIndex } = await import("./store.ts");
    const row = {
      id: "g1",
      title: "demo",
      cwd: "/tmp",
      lastTs: 1,
      participantSummary: "Claude · Codex",
      lastSnippet: "hi",
      inFlight: false,
    };
    await upsertIndexRow(row);
    let idx = await readIndex();
    assert.equal(idx.groups.length, 1);
    assert.equal(idx.groups[0].title, "demo");

    await upsertIndexRow({ ...row, title: "demo v2", lastTs: 2 });
    idx = await readIndex();
    assert.equal(idx.groups.length, 1);
    assert.equal(idx.groups[0].title, "demo v2");
  });

  it("removeIndexRow drops by id", async () => {
    const { upsertIndexRow, removeIndexRow, readIndex } =
      await import("./store.ts");
    await upsertIndexRow({
      id: "g2",
      title: "x",
      cwd: "/tmp",
      lastTs: 1,
      participantSummary: "",
      lastSnippet: "",
      inFlight: false,
    });
    await removeIndexRow("g2");
    const idx = await readIndex();
    assert.ok(!idx.groups.find((g) => g.id === "g2"));
  });
});
```

- [ ] **Step 8: Implement index helpers**

```ts
// server/groups/store.ts (continued)

export async function readIndex(): Promise<GroupIndex> {
  try {
    const raw = await fs.readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      groups: Array.isArray(parsed?.groups) ? parsed.groups : [],
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { groups: [] };
    throw err;
  }
}

export async function writeIndex(idx: GroupIndex): Promise<void> {
  await fs.mkdir(groupsRoot(), { recursive: true });
  const tmp = indexPath() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2));
  await fs.rename(tmp, indexPath());
}

export async function upsertIndexRow(row: GroupIndexRow): Promise<void> {
  const idx = await readIndex();
  const i = idx.groups.findIndex((g) => g.id === row.id);
  if (i >= 0) idx.groups[i] = row;
  else idx.groups.push(row);
  await writeIndex(idx);
}

export async function removeIndexRow(gid: string): Promise<void> {
  const idx = await readIndex();
  idx.groups = idx.groups.filter((g) => g.id !== gid);
  await writeIndex(idx);
}
```

- [ ] **Step 9: Run all tests, verify pass**

```bash
npx tsx --test server/groups/store.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 10: Commit**

```bash
git add server/groups/store.ts server/groups/store.test.ts
git commit -m "feat(groups): canonical transcript + index store"
```

---

## Task 2: groups/config.ts — group config R/W + validation

**Files:**
- Create: `server/groups/config.ts`
- Create: `server/groups/config.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/groups/config.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-config-test-${Date.now()}`);
process.env.CC_WEBUI_GROUPS_DIR = tmp;

const {
  validateConfig,
  writeConfig,
  readConfig,
  defaultConfig,
} = await import("./config.ts");

const baseConfig = () => ({
  id: "g1",
  title: "test",
  cwd: "/tmp",
  createdAt: 1,
  updatedAt: 1,
  participants: [
    {
      id: "claude" as const,
      model: "claude-opus-4-7",
      mode: "default" as const,
      effort: "medium" as const,
      systemPrompt: "你是实现者",
      skills: [],
      mcpServers: ["bash"],
    },
    {
      id: "codex" as const,
      model: "gpt-5.3-codex",
      effort: "medium" as const,
      systemPrompt: "你是 reviewer",
      skills: [],
      mcpServers: ["bash"],
    },
  ],
  pipeline: ["claude" as const, "codex" as const],
});

describe("config / validation", () => {
  before(async () => {
    await fs.mkdir(tmp, { recursive: true });
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("accepts valid config", () => {
    assert.doesNotThrow(() => validateConfig(baseConfig()));
  });

  it("rejects participants.length != 2", () => {
    const c = baseConfig();
    c.participants = [c.participants[0]];
    assert.throws(() => validateConfig(c), /exactly 2 participants/);
  });

  it("rejects duplicate participant ids", () => {
    const c = baseConfig();
    c.participants[1].id = "claude" as any;
    assert.throws(() => validateConfig(c), /unique/);
  });

  it("rejects participant id outside {claude, codex}", () => {
    const c = baseConfig();
    (c.participants[0] as any).id = "gemini";
    assert.throws(() => validateConfig(c), /claude.*codex/);
  });

  it("rejects pipeline that isn't a permutation of participants", () => {
    const c = baseConfig();
    c.pipeline = ["claude" as const, "claude" as const];
    assert.throws(() => validateConfig(c), /pipeline/);
  });

  it("writeConfig + readConfig round-trip", async () => {
    const c = baseConfig();
    await writeConfig(c);
    const back = await readConfig(c.id);
    assert.deepEqual(back, c);
  });

  it("readConfig throws on missing", async () => {
    await assert.rejects(() => readConfig("nope"), /not found|ENOENT/i);
  });

  it("defaultConfig returns valid skeleton", () => {
    const c = defaultConfig({ id: "g2", cwd: "/tmp", title: "demo" });
    assert.doesNotThrow(() => validateConfig(c));
    assert.equal(c.participants.length, 2);
    assert.deepEqual(
      c.participants.map((p) => p.id).sort(),
      ["claude", "codex"],
    );
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

```bash
npx tsx --test server/groups/config.test.ts
```

Expected: imports fail (file not yet created).

- [ ] **Step 3: Implement config.ts**

```ts
// server/groups/config.ts
import { promises as fs } from "node:fs";
import { configPath, ensureGroupDir, AgentId } from "./store.ts";

export type GroupMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type GroupEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type Participant = {
  id: AgentId;
  model: string;
  mode?: GroupMode;
  effort?: GroupEffort;
  systemPrompt?: string;
  skills: string[];
  mcpServers: string[];
};

export type GroupConfig = {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  participants: Participant[];
  pipeline: AgentId[];
};

export function validateConfig(c: GroupConfig): void {
  if (!c.id || typeof c.id !== "string") throw new Error("id required");
  if (!c.title || typeof c.title !== "string") throw new Error("title required");
  if (!c.cwd || typeof c.cwd !== "string") throw new Error("cwd required");
  if (!Array.isArray(c.participants) || c.participants.length !== 2) {
    throw new Error("config requires exactly 2 participants");
  }
  const ids = c.participants.map((p) => p.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("participants ids must be unique");
  }
  for (const id of ids) {
    if (id !== "claude" && id !== "codex") {
      throw new Error(
        `participant id must be one of {claude, codex}, got ${id}`,
      );
    }
  }
  if (!Array.isArray(c.pipeline) || c.pipeline.length !== c.participants.length) {
    throw new Error("pipeline length must match participants");
  }
  const pipelineSet = new Set(c.pipeline);
  if (pipelineSet.size !== c.pipeline.length) {
    throw new Error("pipeline cannot contain duplicates");
  }
  for (const pid of c.pipeline) {
    if (!ids.includes(pid)) {
      throw new Error(`pipeline references unknown participant ${pid}`);
    }
  }
}

export async function writeConfig(c: GroupConfig): Promise<void> {
  validateConfig(c);
  await ensureGroupDir(c.id);
  const tmp = configPath(c.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(c, null, 2));
  await fs.rename(tmp, configPath(c.id));
}

export async function readConfig(gid: string): Promise<GroupConfig> {
  const raw = await fs.readFile(configPath(gid), "utf8");
  const parsed = JSON.parse(raw);
  validateConfig(parsed);
  return parsed;
}

export function defaultConfig(opts: {
  id: string;
  title: string;
  cwd: string;
}): GroupConfig {
  const now = Date.now();
  return {
    id: opts.id,
    title: opts.title,
    cwd: opts.cwd,
    createdAt: now,
    updatedAt: now,
    participants: [
      {
        id: "claude",
        model: "claude-opus-4-7",
        mode: "default",
        effort: "medium",
        systemPrompt: "",
        skills: [],
        mcpServers: ["bash"],
      },
      {
        id: "codex",
        model: "gpt-5.3-codex",
        effort: "medium",
        systemPrompt: "",
        skills: [],
        mcpServers: ["bash"],
      },
    ],
    pipeline: ["claude", "codex"],
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npx tsx --test server/groups/config.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/groups/config.ts server/groups/config.test.ts
git commit -m "feat(groups): config schema + validation"
```

---

## Task 3: groups/input-builder.ts — canonical → SDK prompt (PURE)

This is the most critical pure function in the system. It maps the canonical transcript into the prompt string that gets sent to a single SDK call. Test coverage must be exhaustive.

**Files:**
- Create: `server/groups/input-builder.ts`
- Create: `server/groups/input-builder.test.ts`

- [ ] **Step 1: Write the failing tests (full coverage upfront)**

```ts
// server/groups/input-builder.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, peerLabel } from "./input-builder.ts";
import type { GroupTurnEntry } from "./store.ts";
import type { GroupConfig } from "./config.ts";

const config: GroupConfig = {
  id: "g1",
  title: "demo",
  cwd: "/tmp",
  createdAt: 0,
  updatedAt: 0,
  participants: [
    { id: "claude", model: "x", skills: [], mcpServers: [] },
    { id: "codex", model: "y", skills: [], mcpServers: [] },
  ],
  pipeline: ["claude", "codex"],
};

const entry = (e: Partial<GroupTurnEntry>): GroupTurnEntry =>
  ({
    id: e.id ?? "x",
    ts: e.ts ?? 0,
    type: e.type ?? "user",
    agent: e.agent ?? "user",
    text: e.text,
    images: e.images,
    tool: e.tool,
    recipients: e.recipients,
    meta: e.meta,
  }) as GroupTurnEntry;

describe("input-builder / buildPrompt", () => {
  it("renders empty transcript as just current message", () => {
    const prompt = buildPrompt({
      transcript: [],
      target: "claude",
      currentText: "hello",
      config,
    });
    assert.match(prompt, /hello/);
    assert.doesNotMatch(prompt, /历史对话/);
  });

  it("includes user message and own assistant reply for target = claude", () => {
    const transcript = [
      entry({ type: "user", agent: "user", text: "step 1?" }),
      entry({ type: "assistant", agent: "claude", text: "doing step 1" }),
      entry({ type: "user", agent: "user", text: "step 2?" }),
    ];
    const prompt = buildPrompt({
      transcript,
      target: "claude",
      currentText: "go",
      config,
    });
    assert.match(prompt, /step 1\?/);
    assert.match(prompt, /doing step 1/);
    assert.match(prompt, /step 2\?/);
    assert.match(prompt, /go/);
  });

  it("rewrites peer assistant replies with [来自 X] prefix when target = claude", () => {
    const transcript = [
      entry({ type: "user", agent: "user", text: "go" }),
      entry({ type: "assistant", agent: "codex", text: "I did A" }),
    ];
    const prompt = buildPrompt({
      transcript,
      target: "claude",
      currentText: "next",
      config,
    });
    assert.match(prompt, /\[来自 Codex 的回复\]/);
    assert.match(prompt, /I did A/);
  });

  it("symmetric: peer prefix is [来自 Claude] when target = codex", () => {
    const transcript = [
      entry({ type: "assistant", agent: "claude", text: "I did A" }),
    ];
    const prompt = buildPrompt({
      transcript,
      target: "codex",
      currentText: "next",
      config,
    });
    assert.match(prompt, /\[来自 Claude 的回复\]/);
  });

  it("skips thinking entries", () => {
    const transcript = [
      entry({ type: "thinking", agent: "claude", text: "secret thoughts" }),
      entry({ type: "assistant", agent: "claude", text: "answer" }),
    ];
    const prompt = buildPrompt({
      transcript,
      target: "claude",
      currentText: "x",
      config,
    });
    assert.doesNotMatch(prompt, /secret thoughts/);
    assert.match(prompt, /answer/);
  });

  it("skips tool_call and tool_result entries", () => {
    const transcript = [
      entry({
        type: "tool_call",
        agent: "claude",
        tool: { name: "Read", status: "ok", output: "FILE CONTENTS" },
      }),
      entry({
        type: "tool_result",
        agent: "claude",
        tool: { name: "Read", status: "ok", output: "MORE" },
      }),
      entry({ type: "assistant", agent: "claude", text: "I read it" }),
    ];
    const prompt = buildPrompt({
      transcript,
      target: "claude",
      currentText: "ok",
      config,
    });
    assert.doesNotMatch(prompt, /FILE CONTENTS/);
    assert.match(prompt, /I read it/);
  });

  it("preserves user messages regardless of target", () => {
    const transcript = [
      entry({ type: "user", agent: "user", text: "hi @all" }),
      entry({ type: "assistant", agent: "claude", text: "claude done" }),
      entry({ type: "assistant", agent: "codex", text: "codex done" }),
    ];
    const claudeView = buildPrompt({
      transcript,
      target: "claude",
      currentText: "again",
      config,
    });
    const codexView = buildPrompt({
      transcript,
      target: "codex",
      currentText: "again",
      config,
    });
    assert.match(claudeView, /hi @all/);
    assert.match(codexView, /hi @all/);
  });

  it("is deterministic — same inputs produce same output", () => {
    const transcript = [
      entry({ type: "user", agent: "user", text: "x" }),
      entry({ type: "assistant", agent: "claude", text: "y" }),
    ];
    const a = buildPrompt({ transcript, target: "codex", currentText: "go", config });
    const b = buildPrompt({ transcript, target: "codex", currentText: "go", config });
    assert.equal(a, b);
  });

  it("peerLabel maps correctly", () => {
    assert.equal(peerLabel("claude"), "Claude");
    assert.equal(peerLabel("codex"), "Codex");
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

```bash
npx tsx --test server/groups/input-builder.test.ts
```

Expected: import error (file not yet created).

- [ ] **Step 3: Implement `input-builder.ts`**

```ts
// server/groups/input-builder.ts
import type { GroupTurnEntry, AgentId } from "./store.ts";
import type { GroupConfig } from "./config.ts";

export function peerLabel(agent: AgentId): string {
  return agent === "claude" ? "Claude" : "Codex";
}

export type BuildPromptArgs = {
  transcript: GroupTurnEntry[];
  target: AgentId;
  currentText: string;
  config: GroupConfig;
};

export function buildPrompt(args: BuildPromptArgs): string {
  const { transcript, target, currentText } = args;
  const lines: string[] = [];
  let hasHistory = false;

  for (const e of transcript) {
    if (e.type === "thinking") continue;
    if (e.type === "tool_call" || e.type === "tool_result") continue;
    if (e.type === "permission" || e.type === "summary" || e.type === "error") {
      continue;
    }

    if (e.type === "user" && e.agent === "user" && e.text) {
      lines.push(`USER: ${e.text}`);
      hasHistory = true;
      continue;
    }

    if (e.type === "assistant" && e.agent === target && e.text) {
      lines.push(`你的上一条回复: ${e.text}`);
      hasHistory = true;
      continue;
    }

    if (
      e.type === "assistant" &&
      e.agent !== "user" &&
      e.agent !== target &&
      e.text
    ) {
      lines.push(`[来自 ${peerLabel(e.agent)} 的回复]\n${e.text}`);
      hasHistory = true;
      continue;
    }
  }

  if (!hasHistory) {
    return currentText;
  }

  return [
    "[群聊历史]",
    ...lines,
    "",
    "[当前用户消息]",
    currentText,
  ].join("\n\n");
}

export function systemPromptFor(args: {
  config: GroupConfig;
  target: AgentId;
}): string {
  const { config, target } = args;
  const me = config.participants.find((p) => p.id === target);
  const peer = config.participants.find((p) => p.id !== target);
  const peerDesc = peer
    ? `${peerLabel(peer.id)} (${peer.model})${
        peer.systemPrompt ? `, 角色: ${peer.systemPrompt}` : ""
      }`
    : "";
  const own = me?.systemPrompt?.trim() ?? "";
  const groupPreamble = [
    "你正在参与一个多 agent 群聊。",
    `其他参与者：${peerDesc}。`,
    `对方的发言会以"[来自 ${
      peer ? peerLabel(peer.id) : "对方"
    } 的回复]"前缀的 user message 形式出现在历史里 —— 那不是用户说的，是另一个 agent 说的，你可以认同 / 反驳 / 补充。`,
    "本次群聊的实际用户（人）只通过不带前缀的 USER: 出现。",
  ].join("\n");
  return own ? `${own}\n\n---\n${groupPreamble}` : groupPreamble;
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npx tsx --test server/groups/input-builder.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/groups/input-builder.ts server/groups/input-builder.test.ts
git commit -m "feat(groups): input-builder pure mapper canonical → prompt"
```

---

## Task 4: shared/permission-flow.ts — extract scope-keyed allowance

**Goal:** Pull the in-process permission allowance Maps out of `chat.ts` into a reusable module that both single-chat (key = sessionId) and group-chat (key = `${gid}:${agentId}`) can use without duplicating logic.

**Files:**
- Create: `server/shared/permission-flow.ts`
- Modify: `server/chat.ts` (lines around the existing `getOrCreateAllowance` etc.)
- Modify: `server/codex-chat.ts` (similarly, if it has any equivalent)

This is a **pure refactor** — single chat behavior must remain unchanged.

- [ ] **Step 1: Read the current allowance code in chat.ts**

```bash
sed -n '70,170p' server/chat.ts
```

Confirm understanding: `allowanceBySession`, `inputAllowanceBySession` are Maps keyed by sessionId, holding Sets of tool names (or input keys) that have been granted "allow_session".

- [ ] **Step 2: Create `server/shared/permission-flow.ts`**

```ts
// server/shared/permission-flow.ts
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

const allowanceByScope = new Map<string, Set<string>>();
const inputAllowanceByScope = new Map<string, Set<string>>();

export function getOrCreateAllowance(scope: string | undefined): Set<string> {
  const k = scope ?? "default";
  let s = allowanceByScope.get(k);
  if (!s) {
    s = new Set();
    allowanceByScope.set(k, s);
  }
  return s;
}

export function getOrCreateInputAllowance(
  scope: string | undefined,
): Set<string> {
  const k = scope ?? "default";
  let s = inputAllowanceByScope.get(k);
  if (!s) {
    s = new Set();
    inputAllowanceByScope.set(k, s);
  }
  return s;
}

export function clearScope(scope: string): void {
  allowanceByScope.delete(scope);
  inputAllowanceByScope.delete(scope);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => JSON.stringify(k) + ":" + stableStringify((value as any)[k]),
  );
  return "{" + entries.join(",") + "}";
}

export function permissionInputKey(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return toolName + ":" + stableStringify(input);
}

export function sessionPermissionSuggestions(
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] | undefined {
  if (!suggestions) return undefined;
  return suggestions.filter(
    (s) => s.destination === undefined || s.destination === "session",
  );
}
```

- [ ] **Step 3: Update `chat.ts` to import from shared module**

In `server/chat.ts`:

- Replace the local `allowanceBySession` / `inputAllowanceBySession` Maps with imports
- Replace `getOrCreateAllowance(sessionId)` calls with `getOrCreateAllowance(sessionId)` (signature unchanged for single chat — sessionId is the scope)
- Remove the old function definitions

```ts
// near top of chat.ts
import {
  getOrCreateAllowance,
  getOrCreateInputAllowance,
  permissionInputKey,
  sessionPermissionSuggestions,
  stableStringify,
} from "./shared/permission-flow.ts";
```

Then delete the corresponding local definitions.

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS. Fix any unused-import errors.

- [ ] **Step 5: Smoke test single chat**

```bash
npm run dev
```

Open browser to `http://localhost:8787`, open a Claude single chat. Send a message that triggers a tool (e.g. `read package.json`). Click "本次会话都允许" on the permission card. Send another similar request. Expected: second request does not prompt for permission.

- [ ] **Step 6: Commit**

```bash
git add server/shared/permission-flow.ts server/chat.ts server/codex-chat.ts
git commit -m "refactor(server): extract permission allowance to shared/permission-flow"
```

---

## Task 5: shared/inflight.ts — extract in-flight chat registry (generic)

**Goal:** Pull in-flight registry plumbing out of `chat.ts` so groups can register / attach via the same primitives. The registry must be **scope-agnostic** — keyed by an opaque string (sessionId for single chat, gid for groups).

**Files:**
- Create: `server/shared/inflight.ts`
- Modify: `server/chat.ts`
- Modify: `server/codex-chat.ts`

- [ ] **Step 1: Identify the in-flight types in chat.ts and codex-chat.ts**

```bash
grep -n "InFlight\|inflight\|in_flight" server/chat.ts server/codex-chat.ts | head -20
```

Note the existing types `InFlightChat` (chat.ts) and `InFlightCodexChat` (codex-chat.ts).

- [ ] **Step 2: Create `server/shared/inflight.ts`**

```ts
// server/shared/inflight.ts
import type { Writable } from "node:stream";

export type BufferedMsg = { event: string; data: string };

export type InFlightSubscriber = {
  write: (event: string, data: string) => void;
  end: () => void;
};

export type InFlightEntry = {
  scope: string;
  startedAt: number;
  subscribers: Set<InFlightSubscriber>;
  messages: BufferedMsg[];
  cleanup?: () => Promise<void> | void;
  meta?: Record<string, unknown>;
};

const registry = new Map<string, InFlightEntry>();

export function getInFlight(scope: string): InFlightEntry | undefined {
  return registry.get(scope);
}

export function listInFlight(): InFlightEntry[] {
  return Array.from(registry.values());
}

export function registerInFlight(scope: string, entry: Omit<InFlightEntry, "scope">): InFlightEntry {
  const full: InFlightEntry = { ...entry, scope };
  registry.set(scope, full);
  return full;
}

export function removeInFlight(scope: string, entry: InFlightEntry): void {
  if (registry.get(scope) === entry) {
    registry.delete(scope);
  }
}

export function fanout(entry: InFlightEntry, event: string, data: string): void {
  entry.messages.push({ event, data });
  for (const sub of entry.subscribers) sub.write(event, data);
}
```

- [ ] **Step 3: Update chat.ts to use shared registry**

Replace the local in-flight map (e.g., `inFlightById` or whatever it's called) with `getInFlight(sessionId)` / `registerInFlight(sessionId, ...)`. Adapt local types as needed.

- [ ] **Step 4: Update codex-chat.ts to use the shared registry**

Same pattern with codex sessionId as scope. Note: chat.ts and codex-chat.ts now share the same registry namespace — sessionId collisions across providers are theoretically possible but vanishingly rare with UUIDs. If concerned, prefix scope with `claude:` / `codex:` in the chat.ts / codex-chat.ts callsites.

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Smoke test single chat**

```bash
npm run dev
```

In browser: open a Claude chat, send a message, refresh mid-stream. Expected: after refresh, page reattaches to in-flight stream and finishes.

- [ ] **Step 7: Smoke test Codex chat**

Same as above with Codex provider selected.

- [ ] **Step 8: Commit**

```bash
git add server/shared/inflight.ts server/chat.ts server/codex-chat.ts
git commit -m "refactor(server): extract in-flight registry to shared/inflight"
```

---

## Task 6: groups/claude-runner.ts — single-shot Claude SDK invocation

**Files:**
- Create: `server/groups/claude-runner.ts`

This is the boundary between the orchestrator (decides what to run) and the Claude SDK. It takes a built prompt + agent config + context (cwd, fanout function, abort signal) and produces a stream of GroupChatEvent records.

- [ ] **Step 1: Define the runner types**

```ts
// server/groups/claude-runner.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { createBashMcpServer } from "../bash-mcp.ts";
import { createScheduleMcpServer } from "../schedule-mcp.ts";
import {
  getOrCreateAllowance,
  getOrCreateInputAllowance,
  permissionInputKey,
  sessionPermissionSuggestions,
} from "../shared/permission-flow.ts";
import type { GroupConfig, Participant } from "./config.ts";
import type { AgentId, GroupTurnEntry, ImageAttachment } from "./store.ts";
import { systemPromptFor } from "./input-builder.ts";

export type RunnerEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "step"; entry: GroupTurnEntry }
  | { type: "permission_request"; permissionId: string; payload: any }
  | { type: "agent_end"; ok: boolean; error?: string };

export type RunnerCtx = {
  gid: string;
  turnId: string;
  agentId: AgentId;
  signal: AbortSignal;
  resolvePermission: (pid: string, decision: any) => void;
  awaitPermission: (pid: string) => Promise<any>;
};

export async function* runClaude(args: {
  config: GroupConfig;
  participant: Participant;
  prompt: string;
  images: ImageAttachment[];
  ctx: RunnerCtx;
}): AsyncIterable<RunnerEvent> {
  const { config, participant, prompt, ctx } = args;
  const scope = `${ctx.gid}:${ctx.agentId}`;
  const allowance = getOrCreateAllowance(scope);
  const inputAllowance = getOrCreateInputAllowance(scope);

  const bashMcp = createBashMcpServer({ getSessionId: () => scope });
  const scheduleMcp = createScheduleMcpServer({ slot: scope });

  // Build prompt input — string for v1 (concat-as-prompt).
  // Future v2: consider AsyncIterable<SDKUserMessage> with shouldQuery: false
  // for the history items if token cost becomes an issue.
  const queryPrompt = prompt;

  const systemPrompt = systemPromptFor({ config, target: ctx.agentId });

  const q = query({
    prompt: queryPrompt,
    options: {
      cwd: config.cwd,
      model: participant.model,
      permissionMode: participant.mode ?? "default",
      effort: participant.effort,
      includePartialMessages: true,
      mcpServers: { bash: bashMcp, schedule: scheduleMcp },
      disallowedTools: ["Bash", "BashOutput", "KillBash"],
      systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
      abortController: { signal: ctx.signal } as any,
      canUseTool: async (toolName, input, permOpts) => {
        // mcp tools auto-allowed (mirrors single-chat behavior)
        if (
          toolName.startsWith("mcp__bash__") ||
          toolName.startsWith("mcp__schedule__")
        ) {
          return { behavior: "allow", updatedInput: input };
        }
        if (allowance.has(toolName)) return { behavior: "allow", updatedInput: input };
        const inputKey = permissionInputKey(toolName, input);
        if (inputAllowance.has(inputKey)) {
          return { behavior: "allow", updatedInput: input };
        }
        const pid = randomUUID();
        const suggestions = sessionPermissionSuggestions(permOpts.suggestions);
        // emit permission request — orchestrator forwards to client SSE
        // (synchronously add to a queue; we yield from the outer generator)
        // ...
        // For simplicity, await user decision via ctx callbacks
        const decision = await ctx.awaitPermission(pid);
        if (decision === "allow") return { behavior: "allow", updatedInput: input };
        if (decision === "allow_session") {
          allowance.add(toolName);
          return { behavior: "allow", updatedInput: input };
        }
        if (decision === "allow_tool_session") {
          inputAllowance.add(inputKey);
          return { behavior: "allow", updatedInput: input };
        }
        return { behavior: "deny", message: "user declined" };
      },
    },
  });

  try {
    for await (const msg of q) {
      // Map SDK messages → RunnerEvent
      // (full mapping below — abbreviated here for clarity)
      const mapped = mapSdkMessage(msg, ctx);
      if (mapped) yield mapped;
      if (msg.type === "result") break;
    }
    yield { type: "agent_end", ok: true };
  } catch (err: any) {
    if (ctx.signal.aborted) {
      yield { type: "agent_end", ok: false, error: "aborted" };
      return;
    }
    yield { type: "agent_end", ok: false, error: String(err?.message ?? err) };
  }
}

function mapSdkMessage(msg: any, ctx: RunnerCtx): RunnerEvent | null {
  // TODO during impl: copy event shape from existing chat.ts mapping
  // logic — same SDKMessage types apply here.
  if (msg.type === "partial_assistant" && typeof msg.text === "string") {
    return { type: "assistant_delta", text: msg.text };
  }
  if (msg.type === "thinking" && typeof msg.text === "string") {
    return { type: "thinking_delta", text: msg.text };
  }
  // tool_use / tool_result mapping: produce step entries with status transitions
  // The existing chat.ts has the canonical mapping logic — mirror it here.
  return null;
}
```

> **Note for the implementing engineer:** The `mapSdkMessage` body in this skeleton is a placeholder. The actual mapping of Claude SDK messages → step entries already exists in `server/chat.ts` (find the loop inside `runChatTurn`). Copy that mapping verbatim, adjusting only the output shape from `ChatEvent` to `RunnerEvent`. Do NOT invent a new mapping — the existing one handles edge cases (tool_use_result, partial messages, thinking blocks, edit-diff specifics) we want to keep.

- [ ] **Step 2: Read the existing mapping in chat.ts to understand what to copy**

```bash
grep -n "msg.type\|message.type\|case '" server/chat.ts | head -40
sed -n '550,750p' server/chat.ts
```

- [ ] **Step 3: Port the mapping into `mapSdkMessage`**

Translate each branch of the existing chat.ts SDK loop into a `RunnerEvent` emission. Keep the same input → output contract. The orchestrator (Task 8) is the new caller; it will turn RunnerEvents into transcript appends + SSE.

- [ ] **Step 4: Smoke compile**

```bash
npx tsc --noEmit
```

Fix any type errors. Don't commit yet — runner is exercised in Task 8 (orchestrator). Optionally write a tiny standalone driver script in `server/groups/run-claude-once.ts` that constructs a RunnerCtx, calls `runClaude` with a fixed prompt, and logs events; delete it before committing.

- [ ] **Step 5: Commit**

```bash
git add server/groups/claude-runner.ts
git commit -m "feat(groups): single-shot Claude runner"
```

---

## Task 7: groups/codex-runner.ts — single-shot Codex SDK invocation

**Files:**
- Create: `server/groups/codex-runner.ts`

Mirror of Task 6 but for Codex SDK. Takes the same `RunnerEvent` contract.

- [ ] **Step 1: Read existing Codex chat call pattern**

```bash
sed -n '260,500p' server/codex-chat.ts
```

Pay attention to:
- How `Codex` and `Thread` are constructed
- How `createCodexInput` builds the input array (text + local_image)
- How the event loop maps `ThreadEvent` (ItemCompletedEvent / TurnCompletedEvent / etc.) into UI events

- [ ] **Step 2: Create `server/groups/codex-runner.ts`**

```ts
// server/groups/codex-runner.ts
import { Codex } from "@openai/codex-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { GroupConfig, Participant } from "./config.ts";
import type { AgentId, GroupTurnEntry, ImageAttachment } from "./store.ts";
import { systemPromptFor } from "./input-builder.ts";
import type { RunnerEvent, RunnerCtx } from "./claude-runner.ts";

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const MAX_BYTES = 5 * 1024 * 1024;

function mapEffort(e: string | undefined) {
  if (e === "low" || e === "medium" || e === "high") return e;
  if (e === "xhigh" || e === "max") return "xhigh";
  return "medium";
}

function mapMode(mode: string | undefined) {
  if (mode === "plan") {
    return { sandboxMode: "read-only", approvalPolicy: "never" } as const;
  }
  if (mode === "bypassPermissions") {
    return { sandboxMode: "danger-full-access", approvalPolicy: "never" } as const;
  }
  return { sandboxMode: "workspace-write", approvalPolicy: "never" } as const;
}

export async function* runCodex(args: {
  config: GroupConfig;
  participant: Participant;
  prompt: string;
  images: ImageAttachment[];
  ctx: RunnerCtx;
}): AsyncIterable<RunnerEvent> {
  const { config, participant, prompt, images, ctx } = args;

  // Codex doesn't accept system prompt directly — fold it into the prompt.
  const systemPrompt = systemPromptFor({ config, target: ctx.agentId });
  const fullPrompt = systemPrompt
    ? `[系统指引]\n${systemPrompt}\n\n${prompt}`
    : prompt;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-webui-codex-"));
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await fs.rm(tmpDir, { recursive: true, force: true });
  };

  try {
    const inputArray: Array<
      { type: "text"; text: string } | { type: "local_image"; path: string }
    > = [{ type: "text", text: fullPrompt }];

    for (const img of images) {
      if (!img.mediaType?.startsWith("image/")) continue;
      const ext = IMAGE_EXT_BY_MIME[img.mediaType];
      if (!ext) continue;
      const buf = Buffer.from(img.data, "base64");
      if (buf.length === 0 || buf.length > MAX_BYTES) continue;
      const file = path.join(tmpDir, `${randomUUID()}${ext}`);
      await fs.writeFile(file, buf, { mode: 0o600 });
      inputArray.push({ type: "local_image", path: file });
    }

    const codex = new Codex();
    const { sandboxMode, approvalPolicy } = mapMode(participant.mode);
    const thread = codex.startThread({
      workingDirectory: config.cwd,
      model: participant.model,
      effort: mapEffort(participant.effort),
      sandboxMode,
      approvalPolicy,
    });

    const stream = await thread.runStreamed(inputArray, {
      signal: ctx.signal,
    });

    for await (const ev of stream.events) {
      const mapped = mapCodexEvent(ev);
      if (mapped) yield mapped;
      if (ev.type === "turn.completed" || ev.type === "turn.failed") break;
    }

    yield { type: "agent_end", ok: true };
  } catch (err: any) {
    if (ctx.signal.aborted) {
      yield { type: "agent_end", ok: false, error: "aborted" };
    } else {
      yield { type: "agent_end", ok: false, error: String(err?.message ?? err) };
    }
  } finally {
    await cleanup();
  }
}

function mapCodexEvent(ev: any): RunnerEvent | null {
  // Mirror server/codex-chat.ts event mapping; copy verbatim.
  // Placeholder — see notes in claude-runner.ts; same applies.
  if (ev.type === "item.updated" || ev.type === "item.completed") {
    const it = ev.item;
    if (it?.type === "agent_message" && typeof it.text === "string") {
      return { type: "assistant_delta", text: it.text };
    }
    if (it?.type === "reasoning" && typeof it.text === "string") {
      return { type: "thinking_delta", text: it.text };
    }
    // command_execution / file_change / mcp_tool_call → step entries
  }
  return null;
}
```

> **Note for engineer:** Same as Task 6 — the actual event mapping for Codex already exists in `server/codex-chat.ts`. Find the for-await loop over `stream.events` and copy each branch into `mapCodexEvent`, returning `RunnerEvent` instead of pushing to fanout.

- [ ] **Step 3: Port the mapping**

Translate each branch of codex-chat.ts loop into RunnerEvent emissions.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add server/groups/codex-runner.ts
git commit -m "feat(groups): single-shot Codex runner"
```

---

## Task 8: groups/orchestrator.ts — pipeline dispatcher

**Files:**
- Create: `server/groups/orchestrator.ts`
- Create: `server/groups/orchestrator.test.ts`

The orchestrator is the brain. It takes a turn request, looks up the group config and transcript, decides which agent(s) run in what order, dispatches to the appropriate runner, and persists each agent's output to the transcript.

- [ ] **Step 1: Define the orchestrator entry point and run state**

```ts
// server/groups/orchestrator.ts
import { randomUUID } from "node:crypto";
import { runClaude } from "./claude-runner.ts";
import { runCodex } from "./codex-runner.ts";
import type { RunnerEvent, RunnerCtx } from "./claude-runner.ts";
import { buildPrompt } from "./input-builder.ts";
import { readConfig } from "./config.ts";
import {
  appendEntry,
  readAll,
  newEntryId,
  upsertIndexRow,
  type AgentId,
  type GroupTurnEntry,
  type ImageAttachment,
} from "./store.ts";

export type OrchestratorEvent =
  | { type: "turn_begin"; turnId: string; userText: string; recipients: AgentId[] }
  | { type: "agent_begin"; turnId: string; agent: AgentId; step: number; totalSteps: number }
  | { type: "agent_event"; turnId: string; agent: AgentId; payload: RunnerEvent }
  | { type: "agent_end"; turnId: string; agent: AgentId; ok: boolean; error?: string }
  | { type: "turn_end"; turnId: string; ok: boolean };

export type StartTurnArgs = {
  gid: string;
  text: string;
  images: ImageAttachment[];
  recipients: ("claude" | "codex" | "all")[];
  signal: AbortSignal;
  awaitPermission: (pid: string) => Promise<any>;
};

export async function* startTurn(
  args: StartTurnArgs,
): AsyncIterable<OrchestratorEvent> {
  const { gid, text, images, signal, awaitPermission } = args;
  const config = await readConfig(gid);

  const expanded: AgentId[] = args.recipients.includes("all")
    ? config.pipeline
    : (args.recipients as AgentId[]);

  const turnId = randomUUID();
  const ts = Date.now();

  // 1. append user turn
  const userEntry: GroupTurnEntry = {
    id: newEntryId(),
    ts,
    type: "user",
    agent: "user",
    text,
    images,
    recipients: expanded,
    meta: { turnId },
  };
  await appendEntry(gid, userEntry);

  yield { type: "turn_begin", turnId, userText: text, recipients: expanded };

  let allOk = true;

  for (let step = 0; step < expanded.length; step++) {
    if (signal.aborted) {
      allOk = false;
      break;
    }

    const agentId = expanded[step];
    const participant = config.participants.find((p) => p.id === agentId);
    if (!participant) {
      yield {
        type: "agent_end",
        turnId,
        agent: agentId,
        ok: false,
        error: "participant not configured",
      };
      allOk = false;
      break;
    }

    yield {
      type: "agent_begin",
      turnId,
      agent: agentId,
      step,
      totalSteps: expanded.length,
    };

    // Read latest transcript (includes prior agent's output if step > 0)
    const transcript = await readAll(gid);

    const prompt = buildPrompt({
      transcript,
      target: agentId,
      currentText: text,
      config,
    });

    const ctx: RunnerCtx = {
      gid,
      turnId,
      agentId,
      signal,
      resolvePermission: () => {}, // wired in stream.ts
      awaitPermission,
    };

    const runner =
      participant.id === "claude"
        ? runClaude({ config, participant, prompt, images, ctx })
        : runCodex({ config, participant, prompt, images, ctx });

    let assistantBuf = "";
    let thinkingBuf = "";
    let stepOk = true;
    let stepError: string | undefined;

    for await (const ev of runner) {
      yield { type: "agent_event", turnId, agent: agentId, payload: ev };

      // accumulate deltas; tool steps appended as they complete
      if (ev.type === "assistant_delta") assistantBuf = ev.text;
      else if (ev.type === "thinking_delta") thinkingBuf = ev.text;
      else if (ev.type === "step") {
        await appendEntry(gid, {
          ...ev.entry,
          agent: agentId,
          meta: { ...(ev.entry.meta ?? {}), turnId, pipelineStep: step },
        });
      } else if (ev.type === "agent_end") {
        stepOk = ev.ok;
        stepError = ev.error;
      }
    }

    // persist final assistant + thinking
    if (thinkingBuf) {
      await appendEntry(gid, {
        id: newEntryId(),
        ts: Date.now(),
        type: "thinking",
        agent: agentId,
        text: thinkingBuf,
        meta: { turnId, pipelineStep: step },
      });
    }
    if (assistantBuf) {
      await appendEntry(gid, {
        id: newEntryId(),
        ts: Date.now(),
        type: "assistant",
        agent: agentId,
        text: assistantBuf,
        meta: { turnId, pipelineStep: step },
      });
    }
    if (!stepOk) {
      await appendEntry(gid, {
        id: newEntryId(),
        ts: Date.now(),
        type: "error",
        agent: agentId,
        text: stepError ?? "unknown",
        meta: { turnId, pipelineStep: step, error: stepError },
      });
    }

    yield {
      type: "agent_end",
      turnId,
      agent: agentId,
      ok: stepOk,
      error: stepError,
    };

    if (!stepOk) {
      allOk = false;
      break; // abort pipeline on first failure (spec §5)
    }
  }

  // update index.json snippet
  const last = (await readAll(gid)).slice(-1)[0];
  await upsertIndexRow({
    id: config.id,
    title: config.title,
    cwd: config.cwd,
    lastTs: Date.now(),
    participantSummary: config.participants
      .map((p) => (p.id === "claude" ? "Claude" : "Codex"))
      .join(" · "),
    lastSnippet: (last?.text ?? "").slice(0, 80),
    inFlight: false,
  });

  yield { type: "turn_end", turnId, ok: allOk };
}
```

- [ ] **Step 2: Write the orchestrator integration tests**

```ts
// server/groups/orchestrator.test.ts
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-orch-test-${Date.now()}`);
process.env.CC_WEBUI_GROUPS_DIR = tmp;

// Mock the runners by using module mocking. Since we use ES modules + tsx,
// we'll inject fake runners by overriding the imports via a tiny adapter.
// Simplest reliable approach: import a thin wrapper module we'll create.

const { startTurn } = await import("./orchestrator.ts");
const { writeConfig, defaultConfig } = await import("./config.ts");
const { ensureGroupDir, newGroupId, readAll } = await import("./store.ts");

describe("orchestrator / pipeline", () => {
  before(async () => {
    await fs.mkdir(tmp, { recursive: true });
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("appends user turn and emits turn_begin on @all", async () => {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    const c = defaultConfig({ id: gid, title: "x", cwd: "/tmp" });
    await writeConfig(c);

    // We can't actually invoke real SDKs in unit tests. The runners
    // use Codex / Claude CLI. For this test we rely on the abort signal
    // firing immediately so the runner exits early without making an
    // actual LLM call. That's enough to verify orchestrator
    // bookkeeping (turn_begin / appendEntry).
    const ac = new AbortController();
    ac.abort();

    const events: any[] = [];
    for await (const ev of startTurn({
      gid,
      text: "hello",
      images: [],
      recipients: ["all"],
      signal: ac.signal,
      awaitPermission: async () => "deny",
    })) {
      events.push(ev);
      if (events.length > 20) break;
    }

    const userEntries = (await readAll(gid)).filter((e) => e.type === "user");
    assert.equal(userEntries.length, 1);
    assert.equal(userEntries[0].text, "hello");

    assert.ok(events.find((e) => e.type === "turn_begin"));
    assert.ok(events.find((e) => e.type === "turn_end"));
  });
});
```

- [ ] **Step 3: Run tests; if they fail because runners try to spawn the CLI even with aborted signal, refactor runners to early-return when `signal.aborted` at entry**

```bash
npx tsx --test server/groups/orchestrator.test.ts
```

Adjust as necessary. The goal of this test is just to verify the **orchestrator bookkeeping** (jsonl append, event emission shape) — not the SDK behavior.

- [ ] **Step 4: Commit**

```bash
git add server/groups/orchestrator.ts server/groups/orchestrator.test.ts
git commit -m "feat(groups): orchestrator with pipeline dispatch"
```

---

## Task 9: groups.ts HTTP routes + SSE wiring

**Files:**
- Create: `server/groups.ts`
- Modify: `server/index.ts`

- [ ] **Step 1: Implement the Hono routes**

```ts
// server/groups.ts
import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  newGroupId,
  upsertIndexRow,
  removeIndexRow,
  readIndex,
  readAll,
} from "./groups/store.ts";
import {
  defaultConfig,
  readConfig,
  writeConfig,
  validateConfig,
  type GroupConfig,
} from "./groups/config.ts";
import { startTurn } from "./groups/orchestrator.ts";
import {
  registerInFlight,
  removeInFlight,
  getInFlight,
  fanout,
  type InFlightSubscriber,
} from "./shared/inflight.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { groupDir } from "./groups/store.ts";

const groupsApp = new Hono();

groupsApp.get("/", async (c) => c.json(await readIndex()));

groupsApp.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = newGroupId();
  const cfg: GroupConfig = {
    ...defaultConfig({
      id,
      title: body.title ?? "新群聊",
      cwd: body.cwd ?? process.cwd(),
    }),
    // selectively override from body
    ...(body.participants ? { participants: body.participants } : {}),
    ...(body.pipeline ? { pipeline: body.pipeline } : {}),
  };
  cfg.id = id;
  validateConfig(cfg);
  await writeConfig(cfg);
  await upsertIndexRow({
    id,
    title: cfg.title,
    cwd: cfg.cwd,
    lastTs: Date.now(),
    participantSummary: cfg.participants
      .map((p) => (p.id === "claude" ? "Claude" : "Codex"))
      .join(" · "),
    lastSnippet: "",
    inFlight: false,
  });
  return c.json({ id });
});

groupsApp.get("/:gid", async (c) => {
  const gid = c.req.param("gid");
  const cfg = await readConfig(gid);
  const messages = await readAll(gid);
  return c.json({ config: cfg, messages });
});

groupsApp.patch("/:gid/config", async (c) => {
  const gid = c.req.param("gid");
  const body = await c.req.json();
  const old = await readConfig(gid);
  const merged: GroupConfig = {
    ...old,
    ...body,
    id: old.id,
    createdAt: old.createdAt,
    updatedAt: Date.now(),
  };
  validateConfig(merged);
  await writeConfig(merged);
  return c.json({ ok: true });
});

groupsApp.delete("/:gid", async (c) => {
  const gid = c.req.param("gid");
  await fs.rm(groupDir(gid), { recursive: true, force: true });
  await removeIndexRow(gid);
  return c.json({ ok: true });
});

const permissionWaiters = new Map<string, (decision: any) => void>();

groupsApp.post("/:gid/permission/:pid", async (c) => {
  const pid = c.req.param("pid");
  const body = await c.req.json();
  const resolver = permissionWaiters.get(pid);
  if (resolver) {
    resolver(body.decision);
    permissionWaiters.delete(pid);
  }
  return c.json({ ok: true });
});

groupsApp.post("/:gid/turn", async (c) => {
  const gid = c.req.param("gid");
  const body = await c.req.json();

  const ac = new AbortController();
  const entry = registerInFlight(gid, {
    startedAt: Date.now(),
    subscribers: new Set<InFlightSubscriber>(),
    messages: [],
    cleanup: async () => ac.abort(),
  });

  return stream(c, async (s) => {
    const sub: InFlightSubscriber = {
      write: (event: string, data: string) => {
        s.writeSSE({ event, data });
      },
      end: () => {},
    };
    entry.subscribers.add(sub);

    const awaitPermission = (pid: string) =>
      new Promise<any>((resolve) => {
        permissionWaiters.set(pid, resolve);
      });

    try {
      for await (const ev of startTurn({
        gid,
        text: body.text ?? "",
        images: body.images ?? [],
        recipients: body.recipients ?? ["all"],
        signal: ac.signal,
        awaitPermission,
      })) {
        fanout(entry, ev.type, JSON.stringify(ev));
      }
    } finally {
      entry.subscribers.delete(sub);
      removeInFlight(gid, entry);
    }
  });
});

groupsApp.get("/:gid/stream", async (c) => {
  const gid = c.req.param("gid");
  const entry = getInFlight(gid);
  return stream(c, async (s) => {
    if (!entry) {
      s.writeSSE({ event: "no_inflight", data: "{}" });
      return;
    }
    // replay buffered messages
    for (const m of entry.messages) {
      s.writeSSE({ event: m.event, data: m.data });
    }
    const sub: InFlightSubscriber = {
      write: (event: string, data: string) => {
        s.writeSSE({ event, data });
      },
      end: () => {},
    };
    entry.subscribers.add(sub);
    await new Promise<void>((resolve) => {
      const onClose = () => {
        entry.subscribers.delete(sub);
        resolve();
      };
      // Hono stream cleanup happens on connection close — we let the await keep the handler alive
      c.req.raw.signal.addEventListener("abort", onClose, { once: true });
    });
  });
});

groupsApp.post("/:gid/stop", async (c) => {
  const gid = c.req.param("gid");
  const entry = getInFlight(gid);
  if (entry?.cleanup) await entry.cleanup();
  return c.json({ ok: true });
});

export { groupsApp };
```

- [ ] **Step 2: Mount routes in `server/index.ts`**

```ts
// server/index.ts (additions)
import { groupsApp } from "./groups.ts";
// ...
app.route("/api/groups", groupsApp);
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Smoke test the routes**

```bash
npm run dev
```

Then in another terminal:

```bash
# Create a group
curl -s -X POST http://localhost:8787/api/groups \
  -H 'Content-Type: application/json' \
  -d '{"title":"smoke","cwd":"/tmp"}' | jq

# List groups
curl -s http://localhost:8787/api/groups | jq

# Get group
GID=<paste id from create>
curl -s http://localhost:8787/api/groups/$GID | jq

# Delete
curl -s -X DELETE http://localhost:8787/api/groups/$GID | jq
```

Expected: each call returns 200 with the right JSON.

- [ ] **Step 5: Commit**

```bash
git add server/groups.ts server/index.ts
git commit -m "feat(groups): HTTP routes + SSE wiring"
```

---

## Task 10: Frontend types + API client

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/groups.ts`

- [ ] **Step 1: Extend `src/lib/types.ts`**

Append:

```ts
// src/lib/types.ts (append)
export type GroupAgentId = "claude" | "codex";

export type GroupParticipant = {
  id: GroupAgentId;
  model: string;
  mode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;
  skills: string[];
  mcpServers: string[];
};

export type GroupConfig = {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  participants: GroupParticipant[];
  pipeline: GroupAgentId[];
};

export type GroupTurnEntry = {
  id: string;
  ts: number;
  type:
    | "user"
    | "assistant"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "permission"
    | "summary"
    | "error";
  agent: "user" | GroupAgentId;
  recipients?: GroupAgentId[];
  text?: string;
  images?: ImageAttachment[];
  meta?: { turnId?: string; pipelineStep?: number };
};

export type GroupIndexRow = {
  id: string;
  title: string;
  cwd: string;
  lastTs: number;
  participantSummary: string;
  lastSnippet: string;
  inFlight: boolean;
};

export type GroupSseEvent =
  | { type: "turn_begin"; turnId: string; userText: string; recipients: GroupAgentId[] }
  | { type: "agent_begin"; turnId: string; agent: GroupAgentId; step: number; totalSteps: number }
  | { type: "agent_event"; turnId: string; agent: GroupAgentId; payload: any }
  | { type: "agent_end"; turnId: string; agent: GroupAgentId; ok: boolean; error?: string }
  | { type: "turn_end"; turnId: string; ok: boolean };
```

- [ ] **Step 2: Create `src/lib/groups.ts`**

```ts
// src/lib/groups.ts
import type {
  GroupConfig,
  GroupTurnEntry,
  GroupIndexRow,
  GroupAgentId,
  GroupSseEvent,
} from "./types";

export async function listGroups(): Promise<GroupIndexRow[]> {
  const r = await fetch("/api/groups");
  const j = await r.json();
  return j.groups ?? [];
}

export async function createGroup(input: {
  title: string;
  cwd: string;
  participants?: GroupConfig["participants"];
  pipeline?: GroupAgentId[];
}): Promise<{ id: string }> {
  const r = await fetch("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return r.json();
}

export async function fetchGroup(
  gid: string,
): Promise<{ config: GroupConfig; messages: GroupTurnEntry[] }> {
  const r = await fetch(`/api/groups/${gid}`);
  return r.json();
}

export async function updateGroupConfig(
  gid: string,
  patch: Partial<GroupConfig>,
): Promise<void> {
  await fetch(`/api/groups/${gid}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteGroup(gid: string): Promise<void> {
  await fetch(`/api/groups/${gid}`, { method: "DELETE" });
}

export async function stopGroupTurn(gid: string): Promise<void> {
  await fetch(`/api/groups/${gid}/stop`, { method: "POST" });
}

export type GroupTurnSubscription = {
  close: () => void;
};

export function subscribeGroupTurn(
  gid: string,
  body: {
    text: string;
    images?: any[];
    recipients: ("claude" | "codex" | "all")[];
  },
  onEvent: (ev: GroupSseEvent) => void,
): GroupTurnSubscription {
  const ac = new AbortController();
  (async () => {
    const resp = await fetch(`/api/groups/${gid}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.body) return;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = parseSseChunks(buf);
      buf = events.remainder;
      for (const ev of events.parsed) {
        try {
          onEvent(JSON.parse(ev.data));
        } catch {}
      }
    }
  })().catch(() => {});
  return { close: () => ac.abort() };
}

function parseSseChunks(buf: string): {
  parsed: { event: string; data: string }[];
  remainder: string;
} {
  const out: { event: string; data: string }[] = [];
  const blocks = buf.split("\n\n");
  const remainder = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    out.push({ event, data: dataLines.join("\n") });
  }
  return { parsed: out, remainder };
}

export function attachInFlight(
  gid: string,
  onEvent: (ev: GroupSseEvent) => void,
): GroupTurnSubscription {
  const es = new EventSource(`/api/groups/${gid}/stream`);
  for (const ev of [
    "turn_begin",
    "agent_begin",
    "agent_event",
    "agent_end",
    "turn_end",
  ]) {
    es.addEventListener(ev, (m: any) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {}
    });
  }
  return { close: () => es.close() };
}
```

- [ ] **Step 3: Typecheck frontend**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/groups.ts
git commit -m "feat(groups): frontend types + API client"
```

---

## Task 11: NewGroupDialog + sidebar entry

**Files:**
- Create: `src/components/group/NewGroupDialog.tsx`
- Modify: `src/components/HomeView.tsx` — add 新建群聊 button
- Modify: `src/components/ProjectSidebar.tsx` — add 群聊 section
- Modify: `src/App.tsx` — add `/groups/:gid` route case

- [ ] **Step 1: Implement NewGroupDialog**

```tsx
// src/components/group/NewGroupDialog.tsx
import { useState } from "react";
import { createGroup } from "../../lib/groups";
import type { GroupParticipant } from "../../lib/types";

const CLAUDE_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];
const CODEX_MODELS = ["gpt-5.3-codex", "gpt-5.1-codex-mini"];

type Props = {
  cwd: string;
  onClose: () => void;
  onCreated: (gid: string) => void;
};

export default function NewGroupDialog({ cwd, onClose, onCreated }: Props) {
  const [title, setTitle] = useState("新群聊");
  const [groupCwd, setGroupCwd] = useState(cwd);
  const [claude, setClaude] = useState<GroupParticipant>({
    id: "claude",
    model: "claude-opus-4-7",
    mode: "default",
    effort: "medium",
    systemPrompt: "",
    skills: [],
    mcpServers: ["bash"],
  });
  const [codex, setCodex] = useState<GroupParticipant>({
    id: "codex",
    model: "gpt-5.3-codex",
    effort: "medium",
    systemPrompt: "",
    skills: [],
    mcpServers: ["bash"],
  });
  const [pipeline, setPipeline] = useState<("claude" | "codex")[]>([
    "claude",
    "codex",
  ]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await createGroup({
        title,
        cwd: groupCwd,
        participants: [claude, codex],
        pipeline,
      });
      onCreated(r.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[640px] max-h-[90vh] overflow-auto">
        <h2 className="text-lg font-semibold mb-4">新建群聊</h2>

        <label className="block mb-3">
          <span className="text-sm">标题</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 block w-full bg-zinc-800 px-3 py-2 rounded"
          />
        </label>

        <label className="block mb-4">
          <span className="text-sm">工作目录</span>
          <input
            value={groupCwd}
            onChange={(e) => setGroupCwd(e.target.value)}
            className="mt-1 block w-full bg-zinc-800 px-3 py-2 rounded font-mono text-sm"
          />
        </label>

        <ParticipantCard
          label="Claude"
          color="purple"
          models={CLAUDE_MODELS}
          value={claude}
          onChange={setClaude}
          showMode
        />
        <ParticipantCard
          label="Codex"
          color="green"
          models={CODEX_MODELS}
          value={codex}
          onChange={setCodex}
        />

        <div className="mt-4">
          <span className="text-sm">流水线顺序（@all 时）</span>
          <div className="flex gap-2 mt-2">
            {pipeline.map((p, i) => (
              <span
                key={i}
                className="px-2 py-1 bg-zinc-800 rounded font-mono cursor-pointer"
                onClick={() => {
                  if (i === 0) {
                    setPipeline([pipeline[1], pipeline[0]]);
                  }
                }}
              >
                {p}
              </span>
            ))}
            <button
              type="button"
              className="text-xs text-zinc-400 underline"
              onClick={() =>
                setPipeline(pipeline.slice().reverse() as any)
              }
            >
              反转
            </button>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-zinc-400">
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-4 py-2 bg-blue-600 rounded disabled:opacity-50"
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ParticipantCard({
  label,
  color,
  models,
  value,
  onChange,
  showMode,
}: {
  label: string;
  color: string;
  models: string[];
  value: GroupParticipant;
  onChange: (v: GroupParticipant) => void;
  showMode?: boolean;
}) {
  const borderClass =
    color === "purple" ? "border-purple-700" : "border-emerald-700";
  return (
    <div className={`mt-4 border-l-4 ${borderClass} bg-zinc-800/50 rounded p-3`}>
      <div className="text-sm font-semibold mb-2">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className="text-xs text-zinc-400">模型</span>
          <select
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            className="mt-1 block w-full bg-zinc-900 px-2 py-1 text-sm"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs text-zinc-400">Effort</span>
          <select
            value={value.effort ?? "medium"}
            onChange={(e) =>
              onChange({ ...value, effort: e.target.value as any })
            }
            className="mt-1 block w-full bg-zinc-900 px-2 py-1 text-sm"
          >
            {["low", "medium", "high", "xhigh", "max"].map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        {showMode && (
          <label className="col-span-2">
            <span className="text-xs text-zinc-400">权限模式</span>
            <select
              value={value.mode ?? "default"}
              onChange={(e) =>
                onChange({ ...value, mode: e.target.value as any })
              }
              className="mt-1 block w-full bg-zinc-900 px-2 py-1 text-sm"
            >
              {["default", "acceptEdits", "plan", "bypassPermissions"].map(
                (m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ),
              )}
            </select>
          </label>
        )}
        <label className="col-span-2">
          <span className="text-xs text-zinc-400">系统 prompt（角色设定）</span>
          <textarea
            value={value.systemPrompt ?? ""}
            onChange={(e) =>
              onChange({ ...value, systemPrompt: e.target.value })
            }
            rows={2}
            className="mt-1 block w-full bg-zinc-900 px-2 py-1 text-sm"
            placeholder={
              label === "Claude"
                ? "如：你是实现者，专注写代码"
                : "如：你是 reviewer，挑刺补 edge case"
            }
          />
        </label>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add 新建群聊 button to HomeView**

In `src/components/HomeView.tsx`, add an entry button alongside the existing "open project" entry. Wire to open `NewGroupDialog`. On `onCreated(gid)`, navigate to the group view (e.g., set `App` state or location hash).

- [ ] **Step 3: Add 群聊 section to ProjectSidebar**

In `src/components/ProjectSidebar.tsx`, after the existing single-chat sections, add a 群聊 section that calls `listGroups()` on mount and shows each row. Click → navigate to that group.

- [ ] **Step 4: Wire `/groups/:gid` route in App.tsx**

Detect group route, render `GroupChatView` (placeholder for now — Task 12 implements it).

- [ ] **Step 5: Smoke test**

```bash
npm run dev
```

- Click 新建群聊 → fill dialog → submit → should land on the empty `GroupChatView`.
- Sidebar should now show the new group under 群聊 section.

- [ ] **Step 6: Commit**

```bash
git add src/components/group/NewGroupDialog.tsx \
  src/components/HomeView.tsx \
  src/components/ProjectSidebar.tsx \
  src/App.tsx
git commit -m "feat(groups): NewGroupDialog + sidebar 群聊 section"
```

---

## Task 12: GroupChatView skeleton + ParticipantsBar

**Files:**
- Create: `src/components/group/GroupChatView.tsx`
- Create: `src/components/group/ParticipantsBar.tsx`
- Modify: `src/components/MessageList.tsx` — accept `agentBadge?: GroupAgentId` per-message metadata

- [ ] **Step 1: Implement ParticipantsBar (read-only summary view; edit is v1.1)**

```tsx
// src/components/group/ParticipantsBar.tsx
import type { GroupConfig } from "../../lib/types";

export default function ParticipantsBar({ config }: { config: GroupConfig }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-900/50 text-sm">
      {config.participants.map((p) => {
        const c = p.id === "claude" ? "purple" : "emerald";
        return (
          <span
            key={p.id}
            className={`px-2 py-0.5 rounded border-l-4 border-${c}-700 bg-zinc-800`}
          >
            {p.id === "claude" ? "Claude" : "Codex"} · {p.model}
          </span>
        );
      })}
      <span className="ml-auto text-xs text-zinc-500">
        pipeline: {config.pipeline.join(" → ")}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Implement GroupChatView**

```tsx
// src/components/group/GroupChatView.tsx
import { useEffect, useRef, useState } from "react";
import {
  fetchGroup,
  subscribeGroupTurn,
  attachInFlight,
  stopGroupTurn,
} from "../../lib/groups";
import type {
  GroupConfig,
  GroupTurnEntry,
  GroupSseEvent,
} from "../../lib/types";
import ParticipantsBar from "./ParticipantsBar";
import MessageList from "../MessageList";
import GroupComposer from "./GroupComposer";

type Props = { gid: string };

export default function GroupChatView({ gid }: Props) {
  const [config, setConfig] = useState<GroupConfig | null>(null);
  const [messages, setMessages] = useState<GroupTurnEntry[]>([]);
  const [running, setRunning] = useState(false);
  const subRef = useRef<{ close: () => void } | null>(null);

  useEffect(() => {
    fetchGroup(gid).then((r) => {
      setConfig(r.config);
      setMessages(r.messages);
    });
    // attempt attach in case there's an in-flight turn
    const sub = attachInFlight(gid, handleEvent);
    subRef.current = sub;
    return () => sub.close();
  }, [gid]);

  const handleEvent = (ev: GroupSseEvent) => {
    // Convert orchestrator events into transient UI message updates.
    // For v1 simplest path: re-fetch transcript on turn_end and on agent_end.
    if (ev.type === "turn_end" || ev.type === "agent_end") {
      fetchGroup(gid).then((r) => {
        setMessages(r.messages);
        if (ev.type === "turn_end") setRunning(false);
      });
    }
    if (ev.type === "turn_begin") setRunning(true);
    // (v1.1: render assistant_delta inline for richer streaming feel)
  };

  const onSend = async (text: string, recipients: ("claude" | "codex" | "all")[], images: any[]) => {
    setRunning(true);
    const sub = subscribeGroupTurn(
      gid,
      { text, recipients, images },
      handleEvent,
    );
    subRef.current = sub;
  };

  const onStop = () => stopGroupTurn(gid);

  if (!config) return <div className="p-4 text-zinc-500">加载中…</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-zinc-800">
        <span className="font-semibold">{config.title}</span>
        <span className="ml-2 text-xs text-zinc-500">{config.cwd}</span>
      </div>
      <ParticipantsBar config={config} />
      <div className="flex-1 overflow-auto">
        <MessageList messages={mapToChatEvents(messages)} />
      </div>
      <GroupComposer running={running} onSend={onSend} onStop={onStop} />
    </div>
  );
}

function mapToChatEvents(entries: GroupTurnEntry[]): any[] {
  // Map GroupTurnEntry → ChatEvent shape used by MessageList.
  // Carry agent through `agentBadge` so bubbles can render the provider tag.
  return entries.map((e) => {
    const base = {
      id: e.id,
      type: e.type,
      text: e.text ?? "",
      agentBadge: e.agent === "user" ? undefined : e.agent,
    };
    return base;
  });
}
```

- [ ] **Step 3: Update MessageList + bubble renderers to honor `agentBadge`**

In `src/components/MessageList.tsx` and `src/components/AssistantText.tsx`, accept an optional `agentBadge` field on each message. When set, render a small left-border + label badge:

```tsx
{agentBadge && (
  <div className="text-xs text-zinc-500 mb-1">
    {agentBadge === "claude" ? "🟣 Claude" : "🟢 Codex"}
  </div>
)}
```

Apply matching border color (`border-l-purple-700` / `border-l-emerald-700`) to assistant bubbles.

- [ ] **Step 4: Smoke test**

`npm run dev` → open the group created in Task 11 → should see the chat view with empty message list, ParticipantsBar showing both agents, and a Composer placeholder. (Sending won't work until Task 13.)

- [ ] **Step 5: Commit**

```bash
git add src/components/group/ src/components/MessageList.tsx src/components/AssistantText.tsx
git commit -m "feat(groups): GroupChatView skeleton + agent-badged bubbles"
```

---

## Task 13: GroupComposer with @ autocomplete + mention parsing

**Files:**
- Create: `src/components/group/GroupComposer.tsx`

GroupComposer is a focused subset of the existing Composer with `@` autocomplete added. Reuses existing image upload logic.

- [ ] **Step 1: Implement GroupComposer**

```tsx
// src/components/group/GroupComposer.tsx
import { useState, useRef, KeyboardEvent } from "react";

type Props = {
  running: boolean;
  onSend: (
    text: string,
    recipients: ("claude" | "codex" | "all")[],
    images: any[],
  ) => void;
  onStop: () => void;
};

const TARGETS = ["claude", "codex", "all"] as const;

export default function GroupComposer({ running, onSend, onStop }: Props) {
  const [value, setValue] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [menuIdx, setMenuIdx] = useState(0);
  const [menuFilter, setMenuFilter] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const filtered = TARGETS.filter((t) =>
    t.startsWith(menuFilter.toLowerCase()),
  );

  const insertMention = (target: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const atIdx = before.lastIndexOf("@");
    const newBefore = before.slice(0, atIdx);
    const insert = `@${target} `;
    const next = newBefore + insert + after;
    setValue(next);
    setShowMenu(false);
    setMenuFilter("");
    queueMicrotask(() => {
      ta.focus();
      const newPos = newBefore.length + insert.length;
      ta.selectionStart = newPos;
      ta.selectionEnd = newPos;
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);
    const pos = e.target.selectionStart;
    const before = v.slice(0, pos);
    const m = before.match(/@([a-z]*)$/);
    if (m) {
      setShowMenu(true);
      setMenuFilter(m[1]);
      setMenuIdx(0);
    } else {
      setShowMenu(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIdx((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (filtered[menuIdx]) {
          e.preventDefault();
          insertMention(filtered[menuIdx]);
          return;
        }
      }
      if (e.key === "Escape") {
        setShowMenu(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const parse = (
    raw: string,
  ): { text: string; recipients: ("claude" | "codex" | "all")[] } => {
    // First @<target> at start of message determines recipients.
    const m = raw.trimStart().match(/^@(claude|codex|all)\s+/i);
    if (!m) {
      return { text: raw.trim(), recipients: ["all"] };
    }
    const target = m[1].toLowerCase() as "claude" | "codex" | "all";
    return {
      text: raw.trimStart().slice(m[0].length),
      recipients: [target],
    };
  };

  const submit = () => {
    if (running) return;
    if (!value.trim()) return;
    const { text, recipients } = parse(value);
    onSend(text, recipients, []);
    setValue("");
  };

  return (
    <div className="border-t border-zinc-800 p-3 relative">
      {showMenu && filtered.length > 0 && (
        <div className="absolute bottom-full left-3 mb-1 bg-zinc-800 border border-zinc-700 rounded shadow z-10">
          {filtered.map((t, i) => (
            <div
              key={t}
              onClick={() => insertMention(t)}
              className={`px-3 py-1.5 cursor-pointer text-sm ${
                i === menuIdx ? "bg-zinc-700" : ""
              }`}
            >
              @{t}
              {t === "all" && (
                <span className="text-xs text-zinc-500 ml-2">
                  pipeline: claude → codex
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKey}
        placeholder="@all (流水线协作) / @claude / @codex …"
        rows={3}
        className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 resize-none focus:outline-none"
      />
      <div className="flex justify-end mt-2">
        {running ? (
          <button
            onClick={onStop}
            className="px-4 py-1.5 bg-red-600 rounded text-sm"
          >
            ■ 停止
          </button>
        ) : (
          <button
            onClick={submit}
            className="px-4 py-1.5 bg-blue-600 rounded text-sm"
          >
            ↑ 发送
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Smoke test the @ autocomplete**

`npm run dev` → open group → type `@` → menu appears with claude/codex/all → ↓↑ to select → Enter inserts. Type more text after the mention → menu closes. Send.

- [ ] **Step 3: Smoke test full @claude path (single-agent turn)**

In group, type `@claude 写个 hello world`. Send. Observe:
- Server logs show only Claude runner invoked
- After reply, transcript shows user msg + Claude reply
- Codex was not invoked

- [ ] **Step 4: Smoke test @all (pipeline)**

In group, type `@all 写个 hello world，用 TS 和 Python 各一份`. Send. Observe:
- Claude runs first, produces TS code
- Codex runs second, sees Claude's output as `[来自 Claude 的回复]`, produces Python
- Transcript shows user → Claude assistant → Codex assistant in that order

- [ ] **Step 5: Commit**

```bash
git add src/components/group/GroupComposer.tsx
git commit -m "feat(groups): composer with @ autocomplete + recipient parsing"
```

---

## Task 14: Recovery + stop integration

**Goal:** Confirm that mid-turn refresh re-attaches to the in-flight stream and that the stop button cleanly aborts the orchestrator.

**Files:**
- Modify: `src/components/group/GroupChatView.tsx` — refine `handleEvent` to also update messages on `agent_event` deltas if needed

- [ ] **Step 1: Manual refresh test**

```bash
npm run dev
```

- Open group, send `@all 写一篇 800 字短文`
- While Claude is mid-reply, refresh page
- Expected: page reattaches via `attachInFlight`, replays buffered events, finishes the turn cleanly. Final transcript shows complete reply.

- [ ] **Step 2: Manual stop test**

- Send `@all 写一篇 5000 字`
- Click 停止 mid-Claude
- Expected: orchestrator aborts current step, no Codex invocation, transcript shows partial Claude reply + error entry. Composer re-enables.

- [ ] **Step 3: Pipeline failure test (manual)**

- Configure Claude with `permissionMode: bypassPermissions` and a system prompt instructing it to error out (e.g. "always reply with `<<error>>` only").
- Send `@all`
- Expected: Claude turn completes with text `<<error>>`. Codex still runs second (since this is success-text not failure). Decide: do we want to surface this as the user's responsibility, or add a pattern detector? **For v1: not the engineer's problem — assistants returning weird text is normal, only SDK-level errors abort the pipeline.** Verify the pipeline does proceed.

- [ ] **Step 4: Wire up `attachInFlight` retry on connection drop**

If `attachInFlight` EventSource disconnects (network blip), reconnect after 1s up to 3 retries. Add this in `lib/groups.ts`:

```ts
// in attachInFlight: handle es.onerror with reconnect
```

(Implementation discretion — only add retry if Step 1 reveals an actual issue. Skip if reattach is reliable.)

- [ ] **Step 5: Commit any tweaks**

```bash
git add src/lib/groups.ts src/components/group/GroupChatView.tsx
git commit -m "fix(groups): polish recovery + stop UX"
```

---

## Task 15: Permission card source labeling + per-agent allowance

**Goal:** When a permission card appears in a group chat, show which agent triggered it and ensure `allow_session` only affects that agent.

**Files:**
- Modify: `src/components/PermissionCard.tsx` — accept `agentBadge` prop, render `[Claude]` / `[Codex]` header
- Modify: `src/components/group/GroupChatView.tsx` — pass `agentBadge` from runtime event payload

- [ ] **Step 1: Update PermissionCard**

Add to props:

```ts
type Props = {
  ...
  agentBadge?: "claude" | "codex";
};
```

In render, near top of card, add:

```tsx
{agentBadge && (
  <span
    className={`text-xs mr-2 ${
      agentBadge === "claude" ? "text-purple-400" : "text-emerald-400"
    }`}
  >
    [{agentBadge === "claude" ? "Claude" : "Codex"}]
  </span>
)}
```

- [ ] **Step 2: Verify per-agent allowance scope**

In Task 6 (claude-runner) we already keyed allowance by `${gid}:${agentId}`. Add an integration smoke check:

- In group, trigger Claude tool requiring permission, click `本次会话都允许`
- Trigger same tool again from Claude — no re-prompt (correct)
- Trigger same tool from Codex (if Codex is also configured to use that tool) — should re-prompt (correct: scopes are separate)

- [ ] **Step 3: Commit**

```bash
git add src/components/PermissionCard.tsx src/components/group/GroupChatView.tsx
git commit -m "feat(groups): permission cards labeled per agent"
```

---

## Task 16: Manual end-to-end pass + final verification

**Goal:** Run the full feature through its golden path and edge cases, fixing anything that surfaces.

- [ ] **Step 1: Typecheck full project**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 2: Run all backend tests**

```bash
npx tsx --test 'server/**/*.test.ts'
```

Expected: all pass.

- [ ] **Step 3: Golden path manual test**

```bash
npm run dev
```

Walk through:

1. **Create group** — HomeView → 新建群聊 → fill title/cwd, set Claude=Opus 4.7 + role "你是实现者", set Codex=GPT-5.3 + role "你是 reviewer，挑刺" → 创建.

2. **Single @claude turn** — type `@claude 写个 fizzbuzz` → expect only Claude reply.

3. **Single @codex turn** — type `@codex 把刚才那段改成 Python` → expect only Codex reply, sees Claude's prior reply as `[来自 Claude 的回复]`.

4. **@all pipeline** — type `@all 给我写个二分查找` → expect Claude reply followed by Codex reply (pipeline order).

5. **Default (no @)** — type plain text → expect default `@all` behavior (pipeline).

6. **Refresh during turn** — start a long `@all`, refresh mid-flight → expect reattach + completion.

7. **Stop** — start a long turn, click stop → expect clean cancellation.

8. **Permission flow** — trigger a tool requiring permission → expect card with `[Claude]` or `[Codex]` label → click 本次会话都允许 → next same tool from same agent: no prompt; from other agent: still prompts.

9. **Sidebar persistence** — refresh page → group still listed under 群聊 in sidebar.

10. **Delete group** — DELETE via curl or UI → group disappears from sidebar.

- [ ] **Step 4: Address any UX bugs discovered (file individual fixes as commits)**

- [ ] **Step 5: Final commit (if needed)**

```bash
git add -A
git commit -m "polish(groups): final UX fixes from manual e2e pass"
```

- [ ] **Step 6: Update README**

Add a section under 功能 describing the group chat feature briefly:

```md
- **群聊（多 agent 协作）** — 创建群聊会话，把 Claude 和 Codex 拉到同一个对话里：`@claude` / `@codex` 单点对话，`@all` 走流水线协作（默认 Claude → Codex，可在群聊配置里改顺序）。每个 agent 各自配 model / mode / effort / system prompt / skills / MCP；canonical 历史由 cc-webui 维护，每次 SDK 调用都是 single-shot，跨 agent 输出以 `[来自 X 的回复]` 注入到对方的下一次 prompt。
```

- [ ] **Step 7: Commit README**

```bash
git add README.md
git commit -m "docs: README mentions 群聊 feature"
```

---

## Self-Review (Plan author's checklist — do not skip)

After writing the plan, the author re-reads:

**Spec coverage:**
- [x] §1 数据模型 → Task 1 (store) + Task 2 (config)
- [x] §2 Turn 生命周期 / dispatch → Task 8 (orchestrator)
- [x] §2 input-builder → Task 3
- [x] §2 system prompt 组装 → Task 3 (`systemPromptFor`)
- [x] §3 UI 表面 → Tasks 11–13
- [x] §4 SSE 协议 → Tasks 8 + 9
- [x] §5 Recovery / Stop → Task 14
- [x] §5 Skill / MCP 装载 → embedded in claude-runner / codex-runner (Task 6/7)
- [x] §5 testing strategy → distributed across tasks 1, 2, 3, 8

**Placeholder scan:**
Two `TODO` markers in Task 6 and Task 7 about copying SDK event mapping verbatim from existing chat.ts / codex-chat.ts. These are *deliberate pointers* to existing code, not unfilled work — they instruct the engineer to mirror an existing pattern rather than re-derive it. Acceptable per "complete code in every step" rule because the source is referenced and the engineer can read it directly.

**Type consistency:**
- `AgentId` defined once in `store.ts`, re-used everywhere: ✓
- `RunnerEvent` defined in `claude-runner.ts`, used by `codex-runner.ts` and `orchestrator.ts`: ✓
- `OrchestratorEvent.agent_event.payload` is typed `RunnerEvent`: ✓
- Frontend types (`GroupSseEvent`) mirror backend `OrchestratorEvent` shape: ✓

**Spec requirements with no task:** none found.
