import assert from "node:assert/strict";
import {
  buildMentionInfos,
  listMentionTargets,
  registerBotMentionTarget,
  resetMentionTargetsForTest,
} from "./mentions.ts";

const oldAliases = process.env.FEISHU_MENTION_ALIASES;

try {
  resetMentionTargetsForTest();
  process.env.FEISHU_MENTION_ALIASES = JSON.stringify({
    alice: {
      open_id: "ou_alice",
      name: "Alice",
      aliases: ["pm"],
    },
  });

  registerBotMentionTarget(
    { key: "codex", agentId: "codex", appId: "cli_codex", appSecret: "s" },
    { openId: "ou_codex_bot", name: "codex-bot" },
  );

  const targets = listMentionTargets();
  assert.ok(targets.some((t) => t.alias === "codex-bot"));
  assert.ok(targets.some((t) => t.alias === "alice"));
  assert.ok(targets.some((t) => t.alias === "pm"));

  const built = buildMentionInfos(["codex-bot", "pm"], ["ou_raw"]);
  assert.equal(built.error, undefined);
  assert.deepEqual(
    built.mentions.map((m) => m.openId),
    ["ou_codex_bot", "ou_alice", "ou_raw"],
  );

  const unknown = buildMentionInfos(["nobody"], undefined);
  assert.match(unknown.error ?? "", /unknown mention target/);
} finally {
  if (oldAliases === undefined) delete process.env.FEISHU_MENTION_ALIASES;
  else process.env.FEISHU_MENTION_ALIASES = oldAliases;
  resetMentionTargetsForTest();
}
