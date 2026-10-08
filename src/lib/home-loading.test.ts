import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { listSessions, SEARCH_WINDOW } from "./sessions.ts";

const source = await fs.readFile(new URL("../components/HomeView.tsx", import.meta.url), "utf8");
assert.match(source, /listSessions\(60, undefined, provider, \{ compact: true, signal: controller\.signal \}\)/);
assert.match(source, /listSessions\(SEARCH_WINDOW, undefined, provider, \{ signal: controller\.signal \}\)/, "search must NOT reuse compact first prompts");
assert.match(source, /wideController\.current\?\.abort\(\)/);
assert.match(source, /controller\.abort\(\)/);
assert.match(source, /最近项目加载失败，请重试/);
const originalFetch = globalThis.fetch;
const controller = new AbortController();
let seen = "";
globalThis.fetch = async (input, init) => {
  seen = String(input);
  assert.equal(init?.signal, controller.signal);
  return new Response(JSON.stringify({ sessions: [] }), { headers: { "content-type": "application/json" } });
};
try {
  await listSessions(60, undefined, "codex", { compact: true, signal: controller.signal });
  assert.match(seen, /compact=1/);
  await listSessions(SEARCH_WINDOW, undefined, "codex", { signal: controller.signal });
  assert.doesNotMatch(seen, /compact=/);
} finally { globalThis.fetch = originalFetch; }
console.log("homepage uses compact recent summaries and cancellable full search");
