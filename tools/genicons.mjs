// Regenerate extension/assets/icon-*.png from the Archer mark.
//
// Rendered with a real Chromium so the shipped PNGs are exactly what Chrome
// paints. Stroke weight and inset are tuned per size — a constant weight goes
// spindly at 16px. See docs/BRAND.md for the geometry.
//
// Requires playwright on the module path, same as test/e2e.mjs:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
//
// Usage: npm run icons
//
// This replaced a `chrome --headless --screenshot` shell script, which shipped
// half-painted icons for a year: headless Chromium clips the paint to roughly
// (window height − 88px) while still writing a screenshot the full height of
// the window, so `--window-size=16,16` produced an almost entirely transparent
// PNG. There is no flag that fixes it — the canvas has to be sized by the
// driver, not by a window. `tools/lint.js` now inspects the pixels so a blank
// icon fails the build instead of shipping.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extension", "assets");

// Ink tile, cream legs, brass bow — the two-tone mark from docs/BRAND.md.
// The tile is ink in both themes: Chrome's toolbar and the extensions menu are
// light or dark depending on the profile, and a dark tile holds on either.
const TILE = "#141416";
const LEGS = "#FBF7F0";
const BOW = "#F59E0B";

/** size, corner radius, mark size, stroke width — the table in docs/BRAND.md. */
const SIZES = [
  { size: 128, radius: 28, mark: 84, stroke: 2.4 },
  { size: 48, radius: 11, mark: 32, stroke: 2.6 },
  { size: 32, radius: 7, mark: 22, stroke: 2.9 },
  { size: 16, radius: 4, mark: 12, stroke: 3.3 },
];

const page = (s) => `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: ${s.size}px; height: ${s.size}px; overflow: hidden; background: transparent; }
  .tile {
    width: ${s.size}px; height: ${s.size}px;
    border-radius: ${s.radius}px;
    background: ${TILE};
    display: flex; align-items: center; justify-content: center;
  }
</style>
<div class="tile">
  <svg width="${s.mark}" height="${s.mark}" viewBox="0 0 32 32" fill="none"
       stroke-width="${s.stroke}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 26.5 L16 5.5 L26 26.5" stroke="${LEGS}"/>
    <path d="M9.8 18.5 Q16 24.5 22.2 18.5" stroke="${BOW}"/>
  </svg>
</div>`;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not found — see the header of this file");
  process.exit(2);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });

for (const spec of SIZES) {
  const tab = await browser.newPage({
    viewport: { width: spec.size, height: spec.size },
    deviceScaleFactor: 1,
  });
  await tab.setContent(page(spec), { waitUntil: "load" });

  // omitBackground keeps the area outside the rounded corners transparent; the
  // viewport-sized screenshot is exactly size×size with no cropping step.
  const png = await tab.screenshot({ omitBackground: true });
  writeFileSync(join(OUT, `icon-${spec.size}.png`), png);
  await tab.close();

  console.log(`assets/icon-${spec.size}.png  ${png.length} bytes`);
}

await browser.close();
