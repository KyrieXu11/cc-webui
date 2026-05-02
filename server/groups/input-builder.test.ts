import assert from "node:assert/strict";
import { buildPrompt, peerLabel, systemPromptFor } from "./input-builder.ts";
import type { GroupTurnEntry } from "./store.ts";
import type { GroupConfig } from "./config.ts";

const config: GroupConfig = {
  id: "g1",
  title: "demo",
  cwd: "/tmp",
  createdAt: 0,
  updatedAt: 0,
  participants: [
    { id: "claude", model: "claude-opus-4-7", skills: [], mcpServers: [] },
    { id: "codex", model: "gpt-5.3-codex", skills: [], mcpServers: [] },
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

// peerLabel
assert.equal(peerLabel("claude"), "Claude");
assert.equal(peerLabel("codex"), "Codex");

// empty transcript → just the current message
{
  const prompt = buildPrompt({
    transcript: [],
    target: "claude",
    currentText: "hello",
    config,
  });
  assert.equal(prompt, "hello");
  assert.doesNotMatch(prompt, /历史/);
}

// own assistant + user history visible to target
{
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
  assert.match(prompt, /\[当前用户消息\][\s\S]*go/);
  assert.match(prompt, /你的上一条回复/);
}

// peer reply rewritten with cross-injection prefix when target = claude
{
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
  assert.doesNotMatch(prompt, /你的上一条回复/);
}

// symmetric: peer prefix for target = codex
{
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
}

// thinking entries are skipped
{
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
}

// tool_call / tool_result are skipped
{
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
}

// permission / summary / error rows are skipped
{
  const transcript = [
    entry({ type: "permission", agent: "claude", text: "secret-permission" }),
    entry({ type: "summary", agent: "claude", text: "secret-summary" }),
    entry({ type: "error", agent: "codex", text: "secret-error" }),
    entry({ type: "user", agent: "user", text: "real" }),
  ];
  const prompt = buildPrompt({
    transcript,
    target: "claude",
    currentText: "go",
    config,
  });
  assert.doesNotMatch(prompt, /secret-/);
  assert.match(prompt, /real/);
}

// user messages are visible regardless of target
{
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
  // each agent sees its own as "your previous reply", peer's as "[from X]"
  assert.match(claudeView, /你的上一条回复.*claude done/);
  assert.match(claudeView, /\[来自 Codex.*\][\s\S]*codex done/);
  assert.match(codexView, /你的上一条回复.*codex done/);
  assert.match(codexView, /\[来自 Claude.*\][\s\S]*claude done/);
}

// deterministic
{
  const transcript = [
    entry({ type: "user", agent: "user", text: "x" }),
    entry({ type: "assistant", agent: "claude", text: "y" }),
  ];
  const a = buildPrompt({
    transcript,
    target: "codex",
    currentText: "go",
    config,
  });
  const b = buildPrompt({
    transcript,
    target: "codex",
    currentText: "go",
    config,
  });
  assert.equal(a, b);
}

// systemPromptFor: peer description includes role when set
{
  const c: GroupConfig = {
    ...config,
    participants: [
      {
        id: "claude",
        model: "claude-opus-4-7",
        systemPrompt: "你是实现者",
        skills: [],
        mcpServers: [],
      },
      {
        id: "codex",
        model: "gpt-5.3-codex",
        systemPrompt: "你是 reviewer",
        skills: [],
        mcpServers: [],
      },
    ],
  };
  const sysClaude = systemPromptFor({ config: c, target: "claude" });
  assert.match(sysClaude, /你是实现者/);
  assert.match(sysClaude, /Codex.*角色: 你是 reviewer/);
  // own role appears before group preamble
  assert.ok(
    sysClaude.indexOf("你是实现者") < sysClaude.indexOf("群聊"),
    "own role should appear before group preamble",
  );
}

// systemPromptFor: empty role still renders preamble
{
  const sys = systemPromptFor({ config, target: "claude" });
  assert.match(sys, /群聊/);
  assert.match(sys, /Codex/);
}

console.log("input-builder tests passed");
