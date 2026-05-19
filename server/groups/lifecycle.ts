import { newGroupId, readIndex, upsertIndexRow } from "./store.ts";
import {
  defaultConfig,
  readConfig,
  validateConfig,
  writeConfig,
  type GroupConfig,
  type Participant,
} from "./config.ts";
import { clearAgentSessionId } from "./runtime.ts";
import type { AgentId } from "./store.ts";

// Programmatic group creation. Mirrors the HTTP POST /api/groups handler,
// hoisted so non-HTTP entry points (Feishu adapter, future IM adapters, CLI)
// can create groups without going through the HTTP route.
export async function createGroup(opts: {
  title: string;
  cwd: string;
  participants?: Participant[];
  pipeline?: AgentId[];
}): Promise<string> {
  const id = newGroupId();
  const skeleton = defaultConfig({ id, title: opts.title, cwd: opts.cwd });
  const cfg: GroupConfig = {
    ...skeleton,
    id,
    participants: opts.participants ?? skeleton.participants,
    pipeline: opts.pipeline ?? skeleton.pipeline,
  };
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
  return id;
}

// Change the cwd of an existing group while keeping its transcript and
// canonical history. Clears each agent's persisted SDK session id so the
// next turn starts a fresh SDK session under the new cwd (the buildPrompt
// path will re-feed history as a prompt; prompt cache will warm up again).
//
// Caller must ensure no turn is currently running for this group — switching
// cwd mid-turn would let the SDK observe an inconsistent file tree.
export async function relocateGroup(
  gid: string,
  newCwd: string,
): Promise<GroupConfig> {
  const cfg = await readConfig(gid);
  cfg.cwd = newCwd;
  cfg.updatedAt = Date.now();
  // Bypasses the HTTP PATCH guard intentionally — that guard exists to
  // prevent partial cwd swaps that desync resumed SDK sessions, which we
  // explicitly clear below.
  await writeConfig(cfg);
  for (const p of cfg.participants) {
    await clearAgentSessionId(gid, p.id);
  }
  const idx = await readIndex();
  const oldRow = idx.groups.find((g) => g.id === gid);
  await upsertIndexRow({
    id: cfg.id,
    title: cfg.title,
    cwd: cfg.cwd,
    lastTs: oldRow?.lastTs ?? Date.now(),
    participantSummary: cfg.participants
      .map((p) => (p.id === "claude" ? "Claude" : "Codex"))
      .join(" · "),
    lastSnippet: oldRow?.lastSnippet ?? "",
    inFlight: oldRow?.inFlight ?? false,
  });
  return cfg;
}
