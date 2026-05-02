import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-groups-test-${Date.now()}`);
process.env.CC_WEBUI_GROUPS_DIR = tmp;

const {
  appendEntry,
  readAll,
  ensureGroupDir,
  newGroupId,
  newEntryId,
  upsertIndexRow,
  readIndex,
  removeIndexRow,
  groupDir,
  transcriptPath,
} = await import("./store.ts");

await fs.mkdir(tmp, { recursive: true });

try {
  // appendEntry / readAll round trip
  {
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
    assert.equal(all.length, 2, "expected 2 entries after 2 appends");
    assert.equal(all[0].text, "hello");
    assert.equal(all[1].agent, "claude");
  }

  // readAll on missing transcript returns []
  {
    const gid = newGroupId();
    const all = await readAll(gid);
    assert.deepEqual(all, []);
  }

  // tolerates trailing whitespace and blank lines
  {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    await fs.writeFile(
      transcriptPath(gid),
      `{"id":"a","ts":1,"type":"user","agent":"user","text":"hi"}\n\n  \n`,
    );
    const all = await readAll(gid);
    assert.equal(all.length, 1);
  }

  // skips corrupted line and continues
  {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    await fs.writeFile(
      transcriptPath(gid),
      [
        `{"id":"a","ts":1,"type":"user","agent":"user","text":"hi"}`,
        `not json at all`,
        `{"id":"b","ts":2,"type":"assistant","agent":"claude","text":"hi back"}`,
      ].join("\n") + "\n",
    );
    const all = await readAll(gid);
    assert.equal(all.length, 2);
    assert.equal(all[1].id, "b");
  }

  // index.json: read empty → []
  {
    const idx = await readIndex();
    assert.deepEqual(idx.groups, []);
  }

  // index.json: upsert / update / remove
  {
    const row1 = {
      id: "g1",
      title: "demo",
      cwd: "/tmp",
      lastTs: 1,
      participantSummary: "Claude · Codex",
      lastSnippet: "hi",
      inFlight: false,
    };
    await upsertIndexRow(row1);
    let idx = await readIndex();
    assert.equal(idx.groups.length, 1);
    assert.equal(idx.groups[0].title, "demo");

    await upsertIndexRow({ ...row1, title: "demo v2", lastTs: 2 });
    idx = await readIndex();
    assert.equal(idx.groups.length, 1, "upsert must not duplicate");
    assert.equal(idx.groups[0].title, "demo v2");

    await upsertIndexRow({
      id: "g2",
      title: "x",
      cwd: "/tmp",
      lastTs: 1,
      participantSummary: "",
      lastSnippet: "",
      inFlight: false,
    });
    idx = await readIndex();
    assert.equal(idx.groups.length, 2);

    await removeIndexRow("g2");
    idx = await readIndex();
    assert.equal(idx.groups.length, 1);
    assert.ok(!idx.groups.find((g) => g.id === "g2"));
  }

  console.log("store tests passed");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
