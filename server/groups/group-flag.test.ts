import assert from "node:assert/strict";

// The flag is read from the environment at call time, so each case sets it
// before importing / invoking. groupsEnabled() is pure w.r.t. process.env.
const { groupsEnabled } = await import("../features.ts");
const { capToSoloWhenGroupsDisabled } = await import("./orchestrator.ts");

type AgentId = import("./store.ts").AgentId;

const savedEnv = process.env.CC_WEBUI_GROUPS_ENABLED;

try {
  // ── groupsEnabled(): default off, explicit truthy values on ───────────────

  delete process.env.CC_WEBUI_GROUPS_ENABLED;
  assert.equal(groupsEnabled(), false, "unset must default to disabled");

  for (const v of ["1", "true", "TRUE", "yes", "on", " on "]) {
    process.env.CC_WEBUI_GROUPS_ENABLED = v;
    assert.equal(groupsEnabled(), true, `${JSON.stringify(v)} should enable`);
  }

  for (const v of ["", "0", "false", "no", "off", "maybe"]) {
    process.env.CC_WEBUI_GROUPS_ENABLED = v;
    assert.equal(groupsEnabled(), false, `${JSON.stringify(v)} should disable`);
  }

  // ── capToSoloWhenGroupsDisabled(): enabled is a passthrough ───────────────

  const both: AgentId[] = ["claude", "codex"];
  assert.deepEqual(
    capToSoloWhenGroupsDisabled(both, true),
    ["claude", "codex"],
    "enabled must not alter the pipeline",
  );
  assert.deepEqual(
    capToSoloWhenGroupsDisabled(["codex", "claude"], true),
    ["codex", "claude"],
    "enabled must preserve pipeline order",
  );

  // ── disabled: at most one agent speaks, and it's the first recipient ──────

  assert.deepEqual(
    capToSoloWhenGroupsDisabled(both, false),
    ["claude"],
    "disabled must keep only the first of an @all expansion",
  );
  assert.deepEqual(
    capToSoloWhenGroupsDisabled(["codex", "claude"], false),
    ["codex"],
    "disabled must respect pipeline order, not a hardcoded agent",
  );

  // A single explicit recipient (how Feishu always calls in: one bot per turn)
  // must survive untouched in both states — that's the whole point of gating
  // the 2-participant capability rather than the engine.
  for (const enabled of [true, false]) {
    assert.deepEqual(
      capToSoloWhenGroupsDisabled(["codex"], enabled),
      ["codex"],
      `single recipient must pass through (enabled=${enabled})`,
    );
  }

  // Empty stays empty — startTurn turns this into a "no recipients" throw, and
  // the cap must not paper over it.
  assert.deepEqual(capToSoloWhenGroupsDisabled([], false), []);
  assert.deepEqual(capToSoloWhenGroupsDisabled([], true), []);

  // Non-mutating: the caller's array is config.pipeline, which must not be
  // truncated in place (it would corrupt the in-memory config).
  const pipeline: AgentId[] = ["claude", "codex"];
  capToSoloWhenGroupsDisabled(pipeline, false);
  assert.deepEqual(pipeline, ["claude", "codex"], "must not mutate its input");

  console.log("group-flag.test.ts: all assertions passed");
} finally {
  if (savedEnv === undefined) delete process.env.CC_WEBUI_GROUPS_ENABLED;
  else process.env.CC_WEBUI_GROUPS_ENABLED = savedEnv;
}
