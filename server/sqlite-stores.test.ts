import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-sqlite-stores-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
// Point the NATIVE Codex store at an empty dir so the merge in
// listCodexSessions cannot pull in this machine's real sessions.
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
await fs.mkdir(path.join(tmp, "feishu"), { recursive: true });
await fs.mkdir(path.join(tmp, "groups"), { recursive: true });
await fs.mkdir(path.join(tmp, "codex-empty"), { recursive: true });

const { closeDb } = await import("./db.ts");
const {
  listOpenedProjects,
  recordOpenedProject,
  removeOpenedProject,
} = await import("./opened-projects.ts");
const { getBinding, setBinding, removeBinding } = await import(
  "./feishu/binding.ts"
);
const { importLegacyJson } = await import("./import-legacy-json.ts");
const { readIndex, upsertIndexRow, updateIndexMeta, removeIndexRow } =
  await import("./groups/store.ts");
const { listCodexSessions, getCodexSessionTurns, appendCodexTurn, deleteCodexSession } =
  await import("./session-store.ts");

try {
  // ── legacy import ────────────────────────────────────────────────────────

  const recentsFile = path.join(tmp, "recents.json");
  const bindingsFile = path.join(tmp, "feishu", "bindings.json");
  await fs.writeFile(
    recentsFile,
    JSON.stringify([
      { path: "/a", lastUsed: 300 },
      { path: "/b", lastUsed: 100 },
      { path: "/a", lastUsed: 200 }, // duplicate: newest timestamp must win
      { path: "", lastUsed: 1 }, // junk: skipped
      { nope: true }, // junk: skipped
    ]),
  );
  await fs.writeFile(
    bindingsFile,
    JSON.stringify({ oc_1: "gid-1", oc_2: "gid-2", oc_bad: 42 }),
  );

  const groupsIndexFile = path.join(tmp, "groups", "index.json");
  await fs.writeFile(
    groupsIndexFile,
    JSON.stringify({
      groups: [
        {
          id: "g1",
          title: "G one",
          cwd: "/w1",
          lastTs: 50,
          participantSummary: "Claude",
          lastSnippet: "hi",
          inFlight: true, // never authoritative — must not survive
        },
        { nope: 1 },
      ],
    }),
  );
  const codexIndexFile = path.join(tmp, "sessions.json");
  await fs.writeFile(
    codexIndexFile,
    JSON.stringify({
      codexSessions: [
        {
          sessionId: "cx1",
          provider: "codex",
          cwd: "/w1",
          summary: "old summary",
          firstPrompt: "first",
          lastModified: 77,
          turns: [
            { provider: "codex", prompt: "p1", startedAt: 1, events: [{ a: 1 }] },
            { provider: "codex", prompt: "p2", startedAt: 2, events: [] },
          ],
        },
      ],
    }),
  );

  const first = await importLegacyJson({
    recentsFile,
    bindingsFile,
    groupsIndexFile,
    codexIndexFile,
  });
  assert.equal(first.recents, 3, "3 usable rows, 2 junk skipped");
  assert.equal(first.bindings, 2, "non-string gid skipped");
  assert.equal(first.groups, 1, "row without an id skipped");
  assert.equal(first.codexSessions, 1);
  assert.equal(first.codexTurns, 2);

  const imported = listOpenedProjects();
  assert.deepEqual(
    imported.map((r) => r.path),
    ["/a", "/b"],
    "duplicates collapse, newest first",
  );
  assert.equal(
    imported[0].lastUsed,
    300,
    "MAX() keeps the newest timestamp, not the last row read",
  );
  assert.equal(await getBinding("oc_1"), "gid-1");
  assert.equal(await getBinding("oc_bad"), undefined);

  // Originals retired so the file and the table are never both "truth".
  await assert.rejects(() => fs.access(recentsFile));
  await fs.access(`${recentsFile}.migrated`);
  await fs.access(`${bindingsFile}.migrated`);

  // Re-running is a no-op, not a crash or a double import.
  const second = await importLegacyJson({
    recentsFile,
    bindingsFile,
    groupsIndexFile,
    codexIndexFile,
  });
  assert.deepEqual(second, {
    recents: 0,
    bindings: 0,
    groups: 0,
    codexSessions: 0,
    codexTurns: 0,
  });
  assert.equal(listOpenedProjects().length, 2);

  // ── opened_projects ──────────────────────────────────────────────────────

  recordOpenedProject("/c", "", 400);
  assert.equal(listOpenedProjects()[0].path, "/c", "newest first");

  // Re-recording is an atomic UPSERT — the old file did read-modify-write of
  // the whole array, which lost updates when two writers raced.
  recordOpenedProject("/b", "", 500);
  assert.equal(listOpenedProjects()[0].path, "/b");
  assert.equal(listOpenedProjects().length, 3, "upsert, not insert");

  // Per-user lists are independent: the old shared file capped at 20 meant one
  // user's projects evicted everyone else's.
  recordOpenedProject("/mine", "u1", 999);
  assert.deepEqual(listOpenedProjects("u1").map((r) => r.path), ["/mine"]);
  assert.ok(!listOpenedProjects().some((r) => r.path === "/mine"));

  // The cap is a read-time LIMIT now, so nothing is destroyed by it.
  for (let i = 0; i < 25; i++) recordOpenedProject(`/bulk/${i}`, "u2", 1000 + i);
  assert.equal(listOpenedProjects("u2").length, 20, "default LIMIT");
  assert.equal(listOpenedProjects("u2", 25).length, 25, "nothing was evicted");

  removeOpenedProject("/b");
  assert.ok(!listOpenedProjects().some((r) => r.path === "/b"));
  removeOpenedProject("/nope"); // no-op, must not throw

  // ── feishu bindings ──────────────────────────────────────────────────────

  await setBinding("oc_1", "gid-rebound");
  assert.equal(await getBinding("oc_1"), "gid-rebound", "upsert overwrites");
  assert.equal(await removeBinding("oc_1"), true);
  assert.equal(await removeBinding("oc_1"), false, "second remove reports false");
  assert.equal(await getBinding("oc_1"), undefined);

  // ── groups index ─────────────────────────────────────────────────────────

  let idx = await readIndex();
  assert.equal(idx.groups.length, 1);
  assert.equal(idx.groups[0].id, "g1");
  assert.equal(idx.groups[0].lastTs, 50);
  assert.equal(
    idx.groups[0].inFlight,
    false,
    "inFlight is never persisted; readers fill it from the live registry",
  );

  await upsertIndexRow({
    id: "g2",
    title: "G two",
    cwd: "/w2",
    lastTs: 90,
    participantSummary: "Claude · Codex",
    lastSnippet: "later",
    inFlight: true,
  });
  idx = await readIndex();
  assert.deepEqual(idx.groups.map((g) => g.id), ["g2", "g1"], "newest first");

  // updateIndexMeta must leave lastTs / lastSnippet alone — copying those
  // forward by hand is exactly what lost updates in the old index.json.
  await updateIndexMeta("g1", {
    title: "renamed",
    cwd: "/moved",
    participantSummary: "Codex",
  });
  const g1 = (await readIndex()).groups.find((g) => g.id === "g1")!;
  assert.equal(g1.title, "renamed");
  assert.equal(g1.cwd, "/moved");
  assert.equal(g1.lastTs, 50, "lastTs preserved by the UPDATE itself");
  assert.equal(g1.lastSnippet, "hi", "lastSnippet preserved");

  // Upsert overwrites rather than duplicating.
  await upsertIndexRow({ ...g1, title: "again", lastTs: 99 });
  idx = await readIndex();
  assert.equal(idx.groups.filter((g) => g.id === "g1").length, 1);
  assert.equal(idx.groups[0].id, "g1", "lastTs 99 now sorts first");

  await removeIndexRow("g1");
  assert.deepEqual((await readIndex()).groups.map((g) => g.id), ["g2"]);

  // ── codex sessions / turns ───────────────────────────────────────────────

  const cx1Turns = await getCodexSessionTurns("cx1");
  assert.deepEqual(
    cx1Turns.map((t) => t.prompt),
    ["p1", "p2"],
    "turns come back in order",
  );
  assert.deepEqual(cx1Turns[0].events, [{ a: 1 }], "events round-trip as JSON");

  let sess = await listCodexSessions({ limit: 10 });
  assert.equal(sess.length, 1);
  assert.equal(sess[0].sessionId, "cx1");
  assert.equal(sess[0].summary, "old summary");
  assert.ok(
    !("turns" in (sess[0] as object)),
    "the summary list must not drag transcripts along",
  );

  // Appending must not overwrite an existing summary / firstPrompt (the old
  // code used `session.summary || …`, i.e. first value wins).
  await appendCodexTurn({
    sessionId: "cx1",
    cwd: "/w1",
    prompt: "p3",
    startedAt: 3,
    events: [{ b: 2 }],
  });
  sess = await listCodexSessions({ limit: 10 });
  assert.equal(sess[0].summary, "old summary", "summary not overwritten");
  assert.equal(sess[0].firstPrompt, "first", "firstPrompt not overwritten");
  assert.equal((await getCodexSessionTurns("cx1")).length, 3);

  // A brand-new session gets its summary from the first prompt.
  await appendCodexTurn({
    sessionId: "cx2",
    cwd: "/w9",
    prompt: "brand new task",
    startedAt: 1,
    events: [],
  });
  const cx2 = (await listCodexSessions({ limit: 10 })).find(
    (x) => x.sessionId === "cx2",
  )!;
  assert.equal(cx2.summary, "brand new task");
  assert.equal(cx2.cwd, "/w9");

  // cwd filter still applies.
  assert.deepEqual(
    (await listCodexSessions({ limit: 10, cwd: "/w9" })).map((x) => x.sessionId),
    ["cx2"],
  );

  // Deleting cascades to the turns.
  assert.equal(await deleteCodexSession("cx1"), true);
  assert.deepEqual(await getCodexSessionTurns("cx1"), []);
  assert.equal(
    await deleteCodexSession("cx1"),
    false,
    "second delete reports false",
  );

  console.log("sqlite-stores.test.ts: all assertions passed");
} finally {
  closeDb();
  delete process.env.CC_WEBUI_DB;
  delete process.env.CC_WEBUI_GROUPS_DIR;
  delete process.env.CC_WEBUI_SESSION_INDEX;
  delete process.env.CODEX_SESSIONS_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
}
