import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SIDEBAR_DEFAULT_WIDTH } from "./pane-width.ts";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
assert.match(css, /\.session-sidebar\s*\{\s*width:\s*var\(--sidebarw, 260px\)/);
assert.equal(SIDEBAR_DEFAULT_WIDTH, 260);
assert.match(css, /@media \(max-width: 767px\)\s*\{[\s\S]*?\.session-sidebar\s*\{\s*width:\s*260px;/, "mobile drawer ignores the saved desktop width");
for (const name of ["ProjectSidebar", "EmptyProjectSidebar", "group/GroupSidebar"]) {
  const source = readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), "utf8");
  assert.match(source, /className="session-sidebar shrink-0 flex flex-col"/);
  assert.doesNotMatch(source, /w-\[260px\]/, "fixed utilities must not override the shared CSS width");
}
assert.match(app, /sidebarOpen && !narrow && \(/, "no desktop handle inside the mobile drawer");
assert.match(app, /cssVar="--sidebarw"/);
assert.match(app, /originOffset=\{SIDEBAR_LEFT_OFFSET\}/);
assert.match(app, /storageKey="ccwebui\.sidebar_w"/);
assert.match(app, /reserveMin=\{MIN_MAIN_WIDTH \+ SIDEBAR_FIXED_WIDTH \+ 13\}/);
assert.match(app, /reserveSelector=\{dockOpen && inProject \? "\[data-dockcol\]" : undefined\}/, "opening the right dock reconnects the reciprocal resize observer");
assert.match(css, /\.dragbar-quiet, \.dragbar-quiet:hover\s*\{\s*background:\s*transparent;/, "outer seams are invisible even under the pointer");
console.log("Resizable desktop sidebar shares a persisted width while mobile drawers stay fixed");
