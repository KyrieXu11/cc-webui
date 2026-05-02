import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-config-test-${Date.now()}`);
process.env.CC_WEBUI_GROUPS_DIR = tmp;

const { validateConfig, writeConfig, readConfig, defaultConfig } =
  await import("./config.ts");

await fs.mkdir(tmp, { recursive: true });

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

try {
  // accepts valid
  assert.doesNotThrow(() => validateConfig(baseConfig()));

  // rejects participants.length != 2
  assert.throws(() => {
    const c = baseConfig();
    c.participants = [c.participants[0]] as any;
    validateConfig(c);
  }, /exactly 2 participants/);

  // rejects duplicate ids
  assert.throws(() => {
    const c = baseConfig();
    c.participants[1].id = "claude" as any;
    validateConfig(c);
  }, /unique/);

  // rejects unknown id
  assert.throws(() => {
    const c = baseConfig();
    (c.participants[0] as any).id = "gemini";
    validateConfig(c);
  }, /claude.*codex/);

  // rejects bad pipeline
  assert.throws(() => {
    const c = baseConfig();
    c.pipeline = ["claude", "claude"] as any;
    validateConfig(c);
  }, /pipeline.*duplicate/);

  // round trip via fs
  {
    const c = baseConfig();
    await writeConfig(c);
    const back = await readConfig(c.id);
    assert.deepEqual(back, c);
  }

  // missing config throws
  await assert.rejects(() => readConfig("nope"), /ENOENT|no such/i);

  // defaultConfig is valid + has expected agents
  {
    const c = defaultConfig({ id: "g2", title: "demo", cwd: "/tmp" });
    assert.doesNotThrow(() => validateConfig(c));
    assert.equal(c.participants.length, 2);
    assert.deepEqual(
      c.participants.map((p) => p.id).sort(),
      ["claude", "codex"],
    );
    assert.deepEqual(c.pipeline, ["claude", "codex"]);
  }

  console.log("config tests passed");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
