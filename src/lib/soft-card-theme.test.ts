import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Palette checks need no DOM. Actual layout/interaction checks use the
// isolated browser preview; this guards both themes against washed-out text.
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
// The visual kit supplies surfaces/controls, not a font replacement. Keep the
// original typography the user explicitly prefers, including CJK fallbacks.
assert.match(css, /--font-sans:\s*"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "PingFang SC",\s*"Microsoft YaHei", sans-serif;/);
assert.match(css, /--font-mono:\s*"IBM Plex Mono", ui-monospace, "SF Mono", Consolas, monospace;/);
assert.ok(css.includes("family=IBM+Plex+Sans:"));
assert.ok(css.includes("family=IBM+Plex+Mono:"));
const colors = (block: string) => Object.fromEntries(
  [...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/gi)].map(m => [m[1]!, m[2]!]),
);
const block = (pattern: RegExp) => {
  const match = css.match(pattern);
  assert.ok(match, `missing palette block: ${pattern}`);
  return colors(match[1]!);
};
const dark = {
  ...block(/@theme static \{([\s\S]*?)\n\}/),
  ...block(/\n:root \{([\s\S]*?)\n\}/),
};
const light = { ...dark, ...block(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/) };

function luminance(hex: string) {
  const channels = [1, 3, 5].map(i => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(fg: string, bg: string) {
  const [low, high] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
  return (high! + 0.05) / (low! + 0.05);
}
function readable(palette: Record<string, string>, fg: string, bg: string, theme: string, minimum = 4.5) {
  assert.ok(palette[fg] && palette[bg], `${theme}: missing ${fg}/${bg}`);
  const ratio = contrast(palette[fg]!, palette[bg]!);
  assert.ok(ratio >= minimum, `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (needs ${minimum}:1)`);
}

assert.equal(light["--color-canvas"], "#eef2f8");
assert.equal(light["--color-surface"], "#ffffff");
assert.equal(light["--color-surface-2"], "#f7f9fc");
assert.equal(light["--color-sunken"], "#e3e9f3");
assert.match(css.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)![1]!, /--glass-workspace:\s*var\(--color-canvas\);/, "softcard canvas is flat, not a cyan ambient gradient");
assert.equal(light["--color-blue"], "#1663bf");
assert.notEqual(dark["--color-on-brand"], light["--color-on-brand"]);
for (const [theme, palette] of [["light", light], ["dark", dark]] as const) {
  for (const fg of ["--color-fg", "--color-muted", "--color-subtle"]) {
    for (const bg of ["--color-canvas", "--color-surface", "--color-surface-2", "--color-raised", "--color-sunken", "--color-wash"]) {
      readable(palette, fg, bg, theme);
    }
  }
  readable(palette, "--color-on-brand", "--color-blue", theme);
  for (const state of ["--color-green", "--color-red"]) {
    readable(palette, "--color-on-status", state, theme, 3);
  }
  for (const syntax of ["keyword", "string", "number", "comment", "func", "type", "var", "def", "punct", "meta", "invalid"]) {
    for (const bg of ["--color-surface", "--color-surface-2"]) {
      readable(palette, `--syn-${syntax}`, bg, theme);
    }
  }
}
console.log("Workbench themes: text, controls and editor syntax have readable contrast");
