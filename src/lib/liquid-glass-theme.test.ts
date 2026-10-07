import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const materials = readFileSync(new URL("../liquid-glass.css", import.meta.url), "utf8");
const participants = readFileSync(new URL("../components/group/ParticipantsBar.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const props = (block: string) => Object.fromEntries(
  [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]),
);
const dark = {
  ...props(css.match(/@theme static \{([\s\S]*?)\n\}/)![1]!),
  ...props(css.match(/\n:root \{([\s\S]*?)\n\}/)![1]!),
};
const light = { ...dark, ...props(css.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)![1]!) };
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
function luminance(channels: number[]) {
  const linear = channels.map(v => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
}
const composite = (fg: number[], alpha: number, bg: number[]) => bg.map((v, i) => v * (1 - alpha) + fg[i]! * alpha);
for (const [theme, palette] of [["dark", dark], ["light", light]] as const) {
  const backgrounds = ["--color-canvas", "--glass-ambient-a", "--glass-ambient-b", "--glass-ambient-c"].map(k => rgb(palette[k]!));
  // A deliberately conservative channel envelope covers stacked radial
  // gradients too, rather than checking just the opaque surface token.
  const worst = [0, 1, 2].map(i => (theme === "dark" ? Math.max : Math.min)(...backgrounds.map(c => c[i]!)));
  for (const material of ["nav", "regular", "clear"]) {
    const fill = palette[`--glass-${material}-rgb`]!.split(/\s+/).map(Number);
    const alpha = Number(palette[`--glass-${material}-alpha`]);
    assert(alpha > 0 && alpha < 1);
    let bg = composite(fill, alpha, worst);
    if (theme === "dark") bg = composite([231, 247, 255], .07, bg);
    for (const token of ["--color-fg", "--color-muted", "--color-subtle"]) {
      const values = [luminance(rgb(palette[token]!)), luminance(bg)].sort((a, b) => a - b);
      const ratio = (values[1]! + .05) / (values[0]! + .05);
      assert(ratio >= 4.5, `${theme} ${material}: ${token} is ${ratio.toFixed(2)}:1 on the composited glass`);
    }
  }
}

assert(css.includes('@import "./liquid-glass.css";'));
assert(materials.includes(".workbench-header::before"));
assert(materials.includes("backdrop-filter: blur(var(--glass-blur-clear))"));
assert(materials.includes("(prefers-reduced-transparency: reduce)"));
assert(materials.includes("(prefers-contrast: more)"));
assert(materials.includes("(forced-colors: active)"));
assert(materials.includes("(prefers-reduced-motion: reduce)"));
assert(!/\.chat-panel\s*\{[^}]*backdrop-filter/.test(materials));
assert(!/\.composer-surface\s*\{[^}]*overflow:\s*hidden/.test(materials));
assert(!/\.chat-panel\s*\{[^}]*overflow:\s*hidden/.test(materials));
assert(participants.includes("color-mix(in srgb, ${a.color} 40%, transparent)"));
assert(!participants.includes("${a.color}66"), "CSS var() cannot take a hexadecimal alpha suffix");
assert(app.includes('display: navOpen ? "flex" : "none"'), "Closed mobile navigation must not rely on transform support");
assert(!app.includes("max-md:-translate-x-full"), "An offscreen-only drawer can still block taps on older WebViews");
console.log("Liquid glass: composited chrome contrast, quiet content and accessible fallbacks are guarded");
