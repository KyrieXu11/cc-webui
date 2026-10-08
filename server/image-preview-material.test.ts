import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FilePreviewWindow from "../src/components/FilePreviewWindow.tsx";

const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
const props = { relPath: "sample.png", absPath: "", kind: "image" as const, content: "", imageUrl: "data:image/png;base64,aW1hZ2U=", truncated: false, loading: false, error: null, onClose: () => {} };
try {
  for (const [w, h] of [[1440, 1000], [390, 844]]) {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: w, innerHeight: h } });
    const html = renderToStaticMarkup(createElement(FilePreviewWindow, props));
    assert.match(html, /role="dialog" aria-label="图片预览"/);
    assert.match(html, /image-preview-window/); assert.match(html, /image-preview-titlebar/);
    assert.match(html, /role="toolbar" aria-label="图片操作"/);
    for (const label of ["缩小", "放大", "向左旋转", "向右旋转", "关闭"]) assert(html.includes(`aria-label="${label}"`));
    assert.match(html, /image-view-stage--checker/);
    assert.match(html, /src="data:image\/png;base64,aW1hZ2U="/);
    const width = Number(html.match(/width:(\d+)px/)![1]), left = Number(html.match(/left:(\d+)px/)![1]);
    assert(width + left <= w - 12, "preview and close button fit narrow viewports");
    const pdf = renderToStaticMarkup(createElement(FilePreviewWindow, { ...props, kind: "pdf" }));
    assert.doesNotMatch(pdf, /image-preview-window|image-view-toolbar/);
    const text = renderToStaticMarkup(createElement(FilePreviewWindow, { ...props, kind: "text", relPath: "README.md", content: "## Content" }));
    assert.doesNotMatch(text, /image-preview-window|image-view-toolbar/);
    assert.match(text, /bg-surface/, "text remains on its stable reading surface");
  }
} finally {
  if (previous) Object.defineProperty(globalThis, "window", previous);
  else Reflect.deleteProperty(globalThis, "window");
}
const css = readFileSync(new URL("../src/liquid-glass.css", import.meta.url), "utf8");
assert.match(css, /\.image-preview-window::before\s*\{[^}]*backdrop-filter:\s*blur\(28px\)/);
assert.doesNotMatch(css, /\.(?:image-preview-window|image-view-image|image-view-stage)\s*\{[^}]*\b(?:filter|backdrop-filter|contain)\s*:/);
assert.match(css, /\.image-view-controls\s*\{[^}]*flex-wrap:\s*wrap/, "toolbar wraps rather than hiding controls");
const viewer = readFileSync(new URL("../src/components/ImageView.tsx", import.meta.url), "utf8");
assert(viewer.includes('el.addEventListener("wheel", onWheel, { passive: false })'));
assert(viewer.includes("el?.complete && el.naturalWidth"));
assert(viewer.includes('maxWidth: "none"'));
assert(viewer.includes('setPointerCapture?.(e.pointerId)'));
console.log("Picture preview frosts only chrome and retains the single shared zoom/rotate/pan viewer");
