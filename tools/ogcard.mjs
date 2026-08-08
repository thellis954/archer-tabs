// Renders web/assets/og.png, the 1600x840 card social platforms show when the
// site is linked.
//
// Everything is inlined as a data URI and handed to setContent, so this needs
// no server and no network: the card is not a page the site ships, and there is
// no route it could be fetched from.
//
// Requires playwright on the module path:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
//
// Usage: npm run og

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not found — see the header of this file");
  process.exit(2);
}

const b64 = (rel, mime) =>
  `data:${mime};base64,${readFileSync(join(WEB, rel)).toString("base64")}`;

const FONT = b64("assets/fonts/Geist-Variable.woff2", "font/woff2");
const MONO = b64("assets/fonts/GeistMono-Variable.woff2", "font/woff2");
const ARC = b64("assets/arc-light.webp", "image/webp");

// Tokens copied from docs/BRAND.md rather than imported: this file renders once
// at build time, and a card that silently followed a token change would be a
// worse failure than one that visibly did not.
const card = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: "Geist"; src: url("${FONT}") format("woff2-variations"); font-weight: 100 900; }
  @font-face { font-family: "Geist Mono"; src: url("${MONO}") format("woff2-variations"); font-weight: 100 900; }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1600px; height: 840px;
    background: #FBF7F0;
    color: #141416;
    font-family: "Geist", sans-serif;
    position: relative; overflow: hidden;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 104px;
  }
  .arc {
    position: absolute; right: -140px; top: -80px;
    width: 1020px; opacity: 0.62;
    -webkit-mask-image: radial-gradient(ellipse 66% 66% at 54% 48%, #000 36%, transparent 78%);
  }
  .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 46px; }
  .brand svg { width: 40px; height: 40px; }
  .brand .legs { fill: none; stroke: #141416; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
  .brand .bow  { fill: none; stroke: #B45309; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
  .brand span { font-size: 30px; font-weight: 600; letter-spacing: -0.015em; }
  h1 { font-size: 112px; font-weight: 600; letter-spacing: -0.05em; line-height: 0.94; }
  p { margin-top: 30px; font-size: 34px; color: #78706A; max-width: 24ch; line-height: 1.35; }
  .foot {
    position: absolute; left: 104px; bottom: 76px;
    font-family: "Geist Mono", monospace; font-size: 22px;
    letter-spacing: 0.14em; text-transform: uppercase; color: #78706A;
  }
</style></head><body>
  <img class="arc" src="${ARC}">
  <div class="brand">
    <svg viewBox="0 0 32 32" fill="none">
      <path class="legs" d="M6 26.5 L16 5.5 L26 26.5"/>
      <path class="bow" d="M9.8 18.5 Q16 24.5 22.2 18.5"/>
    </svg>
    <span>Archer</span>
  </div>
  <h1>AI on every<br>new&nbsp;tab.</h1>
  <p>Ask, jump, customise. Free for Chrome.</p>
  <div class="foot">archertabs.app</div>
</body></html>`;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 840 } });
await page.setContent(card, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(200);

const out = join(WEB, "assets/og.png");
writeFileSync(out, await page.screenshot());
await browser.close();
console.log(out);
