import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { memoryPrompt, MEMORY_PROMPT_VERSION } from "./project-memory/prompt.ts";
import { wrapMemoryPrompt, unwrapMemoryPrompt, type MemorySnapshot } from "../shared/project-memory-envelope.ts";

const writable = memoryPrompt(true);
const readonly = memoryPrompt(false);
assert.equal(MEMORY_PROMPT_VERSION, "project-memory-v2");
for (const [mode, prompt] of [["writable", writable], ["readonly", readonly]] as const) {
  const fixture = await readFile(new URL(`./project-memory/fixtures/prompt-v2-${mode}.txt`, import.meta.url), "utf8");
  assert.equal(prompt, fixture, `${mode} rules must match the reviewed versioned fixture`);
}

// The normally served native full/compact prompts are the evidence baseline,
// not the stronger stone-shell or connected-store source-only branches.
const native = await readFile(new URL("../docs/research/claude-memory-2.1.283/claude-sonnet-4-6-new.txt", import.meta.url), "utf8");
const compact = await readFile(new URL("../docs/research/claude-memory-2.1.283/claude-opus-5-5-new.txt", import.meta.url), "utf8");
assert.equal((native.match(/<when_to_save>/g) ?? []).length, 4);
assert.match(native, /confirms a non-obvious approach worked/);
assert.match(native, /convert relative dates.*absolute dates/);
assert.match(compact, /delete memories that turn out to be wrong/);

for (const prompt of [writable, readonly]) {
  assert.match(prompt, /MUST search or list.*check memories, recall prior information or remember/);
  assert.match(prompt, /user: save.*role, expertise, responsibilities, goals or standing preferences/);
  assert.match(prompt, /feedback: save.*corrects your approach OR confirms or clearly accepts/);
  assert.match(prompt, /project: save who is doing what, why, or by when/);
  assert.match(prompt, /reference: save where to find information in external systems/);
  assert.match(prompt, /Do not wait for the literal words/);
  assert.match(prompt, /save it immediately in this turn/);
  assert.match(prompt, /current date and timezone.*absolute dates/);
  assert.match(prompt, /Update a record when verified facts or the user's standing guidance change/);
  assert.match(prompt, /wrong or obsolete.*prefer correcting.*otherwise use mcp__memory__delete/);
  assert.match(prompt, /Never delete merely because a record is old, omitted.*not recently used/);
  assert.match(prompt, /For an explicit request to forget.*read its current revision/);
  assert.match(prompt, /passwords, credentials or API keys/);
  assert.match(prompt, /These exclusions apply even when explicitly asked to save/);
  assert.match(prompt, /do not apply remembered facts, cite, compare against or mention memory content/);
  assert.match(prompt, /All write, update and delete triggers.*only when this turn is writable/);
  assert.match(prompt, /revision_conflict.*read again and reconsider/);
  assert.match(prompt, /same payload with the same ID.*new ID after changing the payload/);
  assert.doesNotMatch(prompt, /write to it directly with the Write tool|Saving a memory is a two-step process/);
  assert.doesNotMatch(prompt, /pinned:|Check each reply before you send it|before.*next tool step/);
}
assert.match(readonly, /Do not save, update or delete memories, even when the user asks/);
assert.match(readonly, /read-only restrictions take precedence/);
assert.doesNotMatch(readonly, /This turn may read, save, update and delete/);
assert.match(writable, /This turn may read, save, update and delete/);

// A semantic prompt revision must not break old/new history stripping or
// change the namespace/store protocol to a second memory library.
const snapshot: MemorySnapshot = { source: "cc-webui-project-memory-v1", scope: "same-project", revision: 1, total: 0, entries: [], truncated: false };
assert.equal(unwrapMemoryPrompt(wrapMemoryPrompt(snapshot, "user request", writable)), "user request");
console.log("project-memory-v2 contracts and reviewed fixtures match captured native memory semantics");
