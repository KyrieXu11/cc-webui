import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSessionListLoader, nextSessionWindow, RECENT_SESSION_COUNT, SESSION_LIST_POLL_MS, sortProjectSessions } from "./project-sessions.ts";
import type { SessionSummary } from "./sessions.ts";

const sessions: SessionSummary[] = Array.from({ length: 30 }, (_, i) => ({
  sessionId: `session-${i}`, provider: "codex", summary: `对话 ${i}`, lastModified: 100 - i,
}));
assert.equal(RECENT_SESSION_COUNT, 5);
assert.equal(SESSION_LIST_POLL_MS, 10_000);
assert.deepEqual(sortProjectSessions([]), []);
assert.deepEqual(sortProjectSessions([...sessions].reverse()), sessions, "native activity time determines order, not API arrival order");
assert.equal(nextSessionWindow(5, 30), 10);
assert.equal(nextSessionWindow(10, 30), 15);
assert.equal(nextSessionWindow(15, 30), 20, "each click reveals five, not the whole fetched page");
assert.equal(nextSessionWindow(10, 13), 13, "the last partial batch is exact");
assert.equal(nextSessionWindow(5, 3), 3, "short lists need no phantom rows");
const activeOld = { ...sessions[22], lastModified: 200 };
const updated = sessions.map((s) => s.sessionId === activeOld.sessionId ? activeOld : s);
assert.equal(sortProjectSessions(updated)[0].sessionId, activeOld.sessionId, "new activity in an old conversation moves it above newly created conversations");
assert.equal(sortProjectSessions(updated).slice(0, 5).length, 5, "the recent window is strictly five, without an extra pinned old selection");
assert.equal(updated[22], activeOld, "sorting never mutates the source list");
assert.equal(sessions.length, 30, "folding never deletes history");

const pending: Array<{ signal: AbortSignal; resolve: (rows: SessionSummary[]) => void; reject: (error: Error) => void }> = [];
let rows: SessionSummary[] = [];
let errors = 0, settled = 0;
const createLoader = () => createSessionListLoader({
  read: (signal) => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })),
  onRows: (next) => { rows = next; },
  onError: () => { errors++; },
  onSettled: () => { settled++; },
});
const loader = createLoader();
const initial = loader.refresh();
await loader.refresh();
assert.equal(pending.length, 1, "focus and timer refreshes coalesce while a read is running");
pending[0].resolve(sessions);
await initial;
assert.equal(rows, sessions);
assert.equal(settled, 1);

const next = [{ ...sessions[0], sessionId: "new-external-session" }, ...sessions];
const background = loader.refresh();
assert.equal(rows, sessions, "background reads retain the old list until the response arrives");
pending[1].resolve(next);
await background;
assert.equal(rows, next, "a new session becomes visible without remounting the list");

const failed = loader.refresh();
pending[2].reject(new Error("offline"));
await failed;
assert.equal(errors, 1);
assert.equal(rows, next, "a failed refresh cannot empty the previous list");
const retry = loader.refresh();
pending[3].resolve(sessions);
await retry;
assert.equal(rows, sessions, "polling recovers after an error");

const stale = loader.refresh();
loader.dispose();
assert(pending[4].signal.aborted, "switching cwd/provider, page size or unmounting cancels the old request");
pending[4].resolve(next); // Simulate a transport that delivers even after abort.
await stale;
assert.equal(rows, sessions, "late responses from a disposed scope are ignored");
assert.equal(settled, 4, "a disposed scope cannot clear the next scope's loading state");
await loader.refresh();
assert.equal(pending.length, 5, "a disposed loader cannot start another request");

const other = createLoader();
const abandoned = other.refresh();
other.dispose();
pending[5].reject(new Error("aborted"));
await abandoned;
assert.equal(errors, 1, "aborted requests do not show spurious errors");

const sidebar = readFileSync(new URL("../components/ProjectSidebar.tsx", import.meta.url), "utf8");
assert.doesNotMatch(sidebar, /IntersectionObserver/, "scrolling alone must never fetch or expand conversations");
assert.match(sidebar, /const visibleSessions = sessions.slice\(0, visibleCount\)/, "only the five-per-click display window is visible");
assert.match(sidebar, /onClick=\{showMore\}/);
assert.match(sidebar, /展开显示.*\{revealCount\}/s);
assert.match(sidebar, /className="conversation-list-footer"/);
assert.match(sidebar, /document.visibilityState === "visible"/, "hidden tabs do not poll the session store");
assert.match(sidebar, /setInterval\(refreshVisible, SESSION_LIST_POLL_MS\)/);
for (const [target, event] of [["document", "visibilitychange"], ["window", "focus"]]) {
  assert(sidebar.includes(`${target}.addEventListener("${event}", refreshVisible)`));
  assert(sidebar.includes(`${target}.removeEventListener("${event}", refreshVisible)`));
}
assert.match(sidebar, /clearInterval\(timer\)/);
assert.match(sidebar, /aria-controls=\{listId\}/);
assert.doesNotMatch(sidebar, /EXPANDED_STORAGE_KEY|sessions_expanded/, "the old all-or-nothing expansion preference must not bypass the recent five");
assert.match(sidebar, /prefers-reduced-motion: reduce/, "scrolling to revealed rows respects reduced motion");
assert.doesNotMatch(sidebar, /key=\{(?:reload|refreshKey|currentSessionId)\}/, "background updates must not remount the list");
console.log("Project conversations collapse safely and refresh without overlaps, lost rows or stale-scope writes");
