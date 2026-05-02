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

const userEntry = (text: string): GroupTurnEntry => ({
  agent: "user",
  ts: 0,
  event: { id: `u-${text}`, type: "user", text },
});

const assistantEntry = (
  agent: "claude" | "codex",
  text: string,
): GroupTurnEntry => ({
  agent,
  ts: 0,
  event: { id: `a-${agent}-${text}`, type: "assistant", text },
});

const thinkingEntry = (
  agent: "claude" | "codex",
  text: string,
): GroupTurnEntry => ({
  agent,
  ts: 0,
  event: { id: `t-${agent}`, type: "thinking", text },
});

const stepEntry = (
  agent: "claude" | "codex",
  output: string,
): GroupTurnEntry => ({
  agent,
  ts: 0,
  event: {
    id: `s-${agent}-${output}`,
    type: "step",
    tool: "Read",
    status: "ok",
    output,
  },
});

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
  const transcript: GroupTurnEntry[] = [
    userEntry("step 1?"),
    assistantEntry("claude", "doing step 1"),
    userEntry("step 2?"),
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
  const transcript: GroupTurnEntry[] = [
    userEntry("go"),
    assistantEntry("codex", "I did A"),
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
  const transcript: GroupTurnEntry[] = [assistantEntry("claude", "I did A")];
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
  const transcript: GroupTurnEntry[] = [
    thinkingEntry("claude", "secret thoughts"),
    assistantEntry("claude", "answer"),
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

// step entries are skipped (tool history not replayed)
{
  const transcript: GroupTurnEntry[] = [
    stepEntry("claude", "FILE CONTENTS"),
    assistantEntry("claude", "I read it"),
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

// user messages visible regardless of target
{
  const transcript: GroupTurnEntry[] = [
    userEntry("hi @all"),
    assistantEntry("claude", "claude done"),
    assistantEntry("codex", "codex done"),
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
  assert.match(claudeView, /你的上一条回复.*claude done/);
  assert.match(claudeView, /\[来自 Codex.*\][\s\S]*codex done/);
  assert.match(codexView, /你的上一条回复.*codex done/);
  assert.match(codexView, /\[来自 Claude.*\][\s\S]*claude done/);
}

// deterministic
{
  const transcript: GroupTurnEntry[] = [
    userEntry("x"),
    assistantEntry("claude", "y"),
  ];
  const a = buildPrompt({ transcript, target: "codex", currentText: "go", config });
  const b = buildPrompt({ transcript, target: "codex", currentText: "go", config });
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
