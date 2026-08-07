// Screenshot the archertabs.app marketing site, light and dark, at three widths
// plus the two interactive states that only exist after a click.
//
// Same reasoning as tools/shots.mjs: the sub-AA `--muted` and the misaligned
// suggestion rows were both invisible in the source and obvious in a render.
// The site has more moving parts than the new tab page, not fewer.
//
// Serves web/ over http rather than opening file:// — app.js is an ES module
// that imports from /vendor/, and module resolution over file:// is blocked.
//
// Requires playwright on the module path:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
//
// Usage: npm run siteshots [outputDir]   (defaults to ./shots/site)

import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname, normalize } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");
const OUT = resolve(process.argv[2] ?? join(ROOT, "shots", "site"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // normalize collapses any ../ before it can escape web/.
  const rel = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB, rel);

  // vercel.json sets cleanUrls, so /privacy is served by privacy.html. Mirror
  // that here, or these shots would exercise a routing the deployed site does
  // not have.
  if (!extname(file) && existsSync(`${file}.html`)) file = `${file}.html`;

  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not found — see the header of this file");
  process.exit(2);
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { name: "full", width: 1440, height: 900, fullPage: true },
  { name: "privacy", width: 1440, height: 900, path: "privacy", fullPage: true },
  { name: "privacy-narrow", width: 420, height: 900, path: "privacy", fullPage: true },
  { name: "hero", width: 1440, height: 900 },
  { name: "narrow", width: 420, height: 900, fullPage: true },
  {
    // The demo armed and answered: the two verdict treatments are the only
    // place the accent carries meaning rather than emphasis.
    name: "demo-url",
    width: 1440,
    height: 900,
    async prepare(page) {
      await page.fill("#demoInput", "en.wikipedia.org/wiki/Toxophily");
    },
  },
  {
    name: "demo-prompt",
    width: 1440,
    height: 900,
    async prepare(page) {
      await page.selectOption("#demoMode", "claude");
      await page.fill("#demoInput", "how do I rebase onto main");
    },
  },
  {
    // Mid-scrollytell: the sticky specimen should be showing rule 4, not rule 1.
    name: "decision",
    width: 1440,
    height: 900,
    async prepare(page) {
      await page.locator(".rule").nth(3).scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "lab",
    width: 1440,
    height: 900,
    async prepare(page) {
      await page.locator("#lab").scrollIntoViewIfNeeded();
      await page.click('.labChips button[data-q="google.com@evil.com"]');
      await page.waitForTimeout(400);
    },
  },
  {
    name: "page",
    width: 1440,
    height: 900,
    async prepare(page) {
      await page.locator("#page").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "modes",
    width: 1440,
    height: 900,
    async prepare(page) {
      await page.locator("#modes").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    },
  },
  {
    // The landing page's permissions section, not the /privacy document above.
    name: "privacy-section",
    width: 1440,
    height: 900,
    async prepare(page) {
      await page.locator("#privacy").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "install",
    width: 1440,
    height: 900,
    async prepare(page) {
      await page.locator("#install").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    },
  },
];

for (const scheme of ["light", "dark"]) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  for (const shot of SHOTS) {
    const ctx = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(BASE + (shot.path ?? ""), { waitUntil: "networkidle" });
    await page.waitForTimeout(300);

    if (shot.fullPage) {
      // Section reveals run on a scroll timeline, and a full-page capture does
      // not scroll: it grows the viewport and shoots once, so every section
      // below the fold sits at the start of its animation and renders blank.
      // Settle them first. This is the only honest way to photograph the whole
      // page at once; the per-viewport shots above show the real entrances.
      await page.addStyleTag({
        content: "*, *::before, *::after { animation: none !important; }",
      });
      await page.waitForTimeout(200);
    }

    await shot.prepare?.(page);
    await page.waitForTimeout(250);

    const path = join(OUT, `${shot.name}-${scheme}.png`);
    await page.screenshot({ path, fullPage: shot.fullPage ?? false });
    console.log(path);
    await ctx.close();
  }

  await browser.close();
}

server.close();
