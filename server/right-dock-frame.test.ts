import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RightDock from "../src/components/RightDock.tsx";

const render = (narrow: boolean, open = true) => renderToStaticMarkup(createElement(RightDock, {
  open, narrow, cwd: "", sessionId: null, onRequestOpen: () => {}, onPreviewFile: () => {},
}));
const desktop = render(false);
assert.match(desktop, /class="dockcol dock-frame"/);
assert.match(desktop, /class="flex flex-none min-w-0 min-h-0 dock-surface"/);
assert.match(desktop, /role="separator"/, "the outside splitter still exists outside the clipped content surface");
assert.match(desktop, /class="dragbar dragbar-quiet"/, "hide the outside line without removing its separator hitbox");
const mobile = render(true);
assert.match(mobile, /fixed inset-0 z-40 bg-surface flex/);
assert.doesNotMatch(mobile, /dock-frame|dock-surface|role="separator"/, "mobile file drawer still fills the viewport without desktop gutters or clipping");
assert.equal(render(false, false), "", "a closed empty dock remains unmounted");
console.log("Right dock frames desktop content without changing the fullscreen/mobile shell");
