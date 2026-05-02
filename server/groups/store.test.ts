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
  transcriptPath,
  makeEntry,
} = await import("./store.ts");

await fs.mkdir(tmp, { recursive: true });

try {
  // appendEntry / readAll round trip — wraps ChatEvent
  {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    const a = makeEntry({
      agent: "user",
      event: { id: newEntryId(), type: "user", text: "hello" },
      turnId: "t1",
      recipients: ["claude"],
    });
    const b = makeEntry({
      agent: "claude",
      event: { id: newEntryId(), type: "assistant", text: "hi" },
      turnId: "t1",
      pipelineStep: 0,
    });
    await appendEntry(gid, a);
    await appendEntry(gid, b);
    const all = await readAll(gid);
    assert.equal(all.length, 2);
    assert.equal(all[0].event.type, "user");
    assert.equal((all[0].event as any).text, "hello");
    assert.deepEqual(all[0].meta?.recipients, ["claude"]);
    assert.equal(all[1].agent, "claude");
    assert.equal((all[1].event as any).text, "hi");
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
      `{"agent":"user","ts":1,"event":{"id":"a","type":"user","text":"hi"}}\n\n  \n`,
    );
    const all = await readAll(gid);
    assert.equal(all.length, 1);
  }

  // skips corrupted line and continues; also skips schema-drift rows
  // that lack an event payload.
  {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    await fs.writeFile(
      transcriptPath(gid),
      [
        `{"agent":"user","ts":1,"event":{"id":"a","type":"user","text":"hi"}}`,
        `not json at all`,
        `{"agent":"claude","ts":2}`,
        `{"agent":"claude","ts":3,"event":{"id":"b","type":"assistant","text":"hi back"}}`,
      ].join("\n") + "\n",
    );
    const all = await readAll(gid);
    assert.equal(all.length, 2);
    assert.equal(all[1].event.id, "b");
  }

  // step entry with full input/output round-trip
  {
    const gid = newGroupId();
    await ensureGroupDir(gid);
    const stepEntry = makeEntry({
      agent: "claude",
      event: {
        id: "s-1",
        type: "step",
        tool: "Read",
        status: "ok",
        input: { file_path: "/foo.ts" },
        output: "FILE CONTENTS",
      },
      turnId: "t1",
      pipelineStep: 0,
    });
    await appendEntry(gid, stepEntry);
    const all = await readAll(gid);
    assert.equal(all.length, 1);
    const ev: any = all[0].event;
    assert.equal(ev.type, "step");
    assert.equal(ev.tool, "Read");
    assert.equal(ev.output, "FILE CONTENTS");
    assert.deepEqual(ev.input, { file_path: "/foo.ts" });
  }

  // index: read empty
  {
    const idx = await readIndex();
    assert.deepEqual(idx.groups, []);
  }

  // index: upsert / update / remove
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
    assert.equal(idx.groups.length, 1);
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
