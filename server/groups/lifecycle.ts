import { newGroupId, updateIndexMeta, upsertIndexRow } from "./store.ts";
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
  const participants = opts.participants ?? skeleton.participants;
  const cfg: GroupConfig = {
    ...skeleton,
    id,
    participants,
    // Default the pipeline to the participants' own order — otherwise a
    // single-participant override would inherit the 2-agent skeleton pipeline
    // and fail validation (pipeline length must match participants).
    pipeline: opts.pipeline ?? participants.map((p) => p.id),
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
  // lastTs / lastSnippet are preserved by the UPDATE itself rather than being
  // read out and copied back — that read-then-write was the losing half of the
  // old index.json race.
  await updateIndexMeta(gid, {
    title: cfg.title,
    cwd: cfg.cwd,
    participantSummary: cfg.participants
      .map((p) => (p.id === "claude" ? "Claude" : "Codex"))
      .join(" · "),
  });
  return cfg;
}

// When a participant's model changes, its persisted native session (Claude
// session id / Codex thread id) was recorded under the OLD model. Resuming it
// under the new model mis-routes and, for Codex, makes the CLI emit a
// "recorded with model X but resuming with Y" advisory. Clear the id for each
// participant whose model changed so the next turn starts a fresh session under
// the new model — canonical history is re-fed via buildPrompt, so nothing is
// lost except the (now-invalid) prompt cache. Mode/effort changes don't affect
// the recorded model, so they don't clear the session.
export async function clearSessionsForModelChanges(
  gid: string,
  before: Participant[],
  after: Participant[],
): Promise<void> {
  for (const next of after) {
    const prev = before.find((p) => p.id === next.id);
    if (prev && prev.model !== next.model) {
      await clearAgentSessionId(gid, next.id);
    }
  }
}
