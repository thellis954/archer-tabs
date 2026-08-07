// Chrome Web Store assets: five 1280×800 screenshots and the two promo tiles.
//
// Generated rather than captured by hand, so a UI change is one command away
// from a correct listing — and so the seeded data in them is obviously
// illustrative rather than someone's real history.
//
// The store's own requirements: screenshots 1280×800 or 640×400, small promo
// tile 440×280, marquee 1400×560. See docs/STORE.md.
//
// Requires playwright on the module path:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
//
// Usage: npm run store

import { mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");
const OUT = join(ROOT, "store");

const extensionId = (path) =>
  [...createHash("sha256").update(path).digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not found — see the header of this file");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

// A fixture with the optional permissions already granted: the grant dialog
// never resolves headless, and a listing screenshot showing the empty state
// would sell the extension short.
const fixture = mkdtempSync(join(tmpdir(), "archer-store-"));
cpSync(EXT, fixture, { recursive: true });
{
  const path = join(fixture, "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  // history too: the lead screenshot should show the product working, not an
  // offer to set it up.
  m.permissions = [...m.permissions, "topSites", "history"];
  m.optional_permissions = m.optional_permissions.filter((p) => !["topSites", "history"].includes(p));
  writeFileSync(path, JSON.stringify(m, null, 2));
}

const NEWTAB = `chrome-extension://${extensionId(fixture)}/newtab.html`;
const OPTIONS = `chrome-extension://${extensionId(fixture)}/options.html`;

/** Obviously illustrative, and it shows every row kind at once. */
const SEED = {
  engineNudgeDismissed: true,
  mode: "chatgpt",
  pinned: [],
  dismissed: [],
  // Two, not four: the favorites bar has to fit inside 800px, and it is half
  // the reason to look at the screenshot.
  launches: [
    { text: "how to fletch an arrow", at: Date.now() - 120_000 },
    { text: "sourdough starter ratios", at: Date.now() - 60_000 },
  ],
  library: [
    { id: "t1", name: "translate", text: "Translate {{text}} into {{language}}" },
    { id: "t2", name: "review", text: "Review this code for bugs" },
  ],
  weatherPlace: { name: "Brighton, England, GB", latitude: 50.82, longitude: -0.14 },
  weatherUnit: "celsius",
  weatherCache: {
    place: "Brighton, England, GB",
    unit: "celsius",
    temperature: 22,
    text: "Partly cloudy",
    icon: "partly",
    high: 29,
    low: 20,
    at: Date.now(),
  },
  favorites: [
    ["youtube.com", "YouTube"],
    ["github.com", "GitHub"],
    ["chatgpt.com", "ChatGPT"],
    ["claude.ai", "Claude"],
    ["linkedin.com", "LinkedIn"],
    ["mail.google.com", "Gmail"],
    ["news.ycombinator.com", "Hacker News"],
    ["figma.com", "Figma"],
  ].map(([host, name]) => ({ id: `https://${host}/`, url: `https://${host}/`, name })),
};

/** Illustrative conversations, across both assistants Archer can recall. */
const CONVERSATIONS = [
  ["https://chatgpt.com/c/0f9c2a41-1b3d-4c8e-9a77-5e2b6d0c4a19", "Evaluate Claude vs rivals"],
  ["https://claude.ai/chat/3c5b7e21-8a4d-4f19-b6c0-2d9e1a7f3b85", "Fletching an arrow properly"],
];

async function withContext(scheme, run) {
  const ctx = await chromium.launchPersistentContext("", {
    headless: true,
    channel: "chromium",
    colorScheme: scheme,
    args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`, "--no-sandbox"],
  });

  // Real visits, so Chrome records real titles and the rows are real recall
  // rather than something painted for the picture.
  const browsing = await ctx.newPage();
  await browsing.route(/^https?:/, (r) => {
    const hit = CONVERSATIONS.find(([url]) => r.request().url() === url);
    return r.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><title>${hit ? hit[1] : "x"}</title><p>x`,
    });
  });
  for (const [url] of CONVERSATIONS) {
    await browsing.goto(url, { waitUntil: "load" });
    await browsing.waitForTimeout(120);
  }
  await browsing.close();

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(NEWTAB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(250);
  await page.evaluate((seed) => chrome.storage.local.set(seed), SEED);
  await page.goto(NEWTAB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);

  await run(page, ctx);
  await ctx.close();
}

const shot = async (page, name) => {
  const path = join(OUT, name);
  await page.screenshot({ path });
  console.log(path);
};

await withContext("light", async (page, ctx) => {
  await shot(page, "screenshot-1-page-light.png");

  await page.locator("#modeButton").click();
  await page.waitForTimeout(250);
  await shot(page, "screenshot-3-destinations.png");
  await page.keyboard.press("Escape");

  await page.fill("#query", "arrow");
  await page.waitForTimeout(250);
  await shot(page, "screenshot-4-recall.png");

  const options = await ctx.newPage();
  await options.setViewportSize({ width: 1280, height: 800 });
  await options.goto(OPTIONS, { waitUntil: "domcontentloaded" });
  await options.waitForTimeout(400);
  await options.evaluate(() => document.querySelector(".grants")?.scrollIntoView({ block: "center" }));
  await options.waitForTimeout(200);
  await shot(options, "screenshot-5-permissions.png");
});

await withContext("dark", async (page) => {
  await shot(page, "screenshot-2-page-dark.png");
});

// --- promo tiles ------------------------------------------------------------------

const tile = (width, height, titleSize, subSize) => `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; }
  .t {
    width: ${width}px; height: ${height}px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${Math.round(height / 28)}px;
    background: #FBF7F0; color: #141416;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  h1 { margin: 0; font-size: ${titleSize}px; font-weight: 600; letter-spacing: -.03em; }
  p  { margin: 0; font-size: ${subSize}px; color: #78706A; }
  svg { width: ${Math.round(height / 3.4)}px; height: ${Math.round(height / 3.4)}px; }
</style>
<div class="t">
  <svg viewBox="0 0 32 32" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 26.5 L16 5.5 L26 26.5" stroke="#141416"/>
    <path d="M9.8 18.5 Q16 24.5 22.2 18.5" stroke="#B45309"/>
  </svg>
  <h1>Archer</h1>
  <p>Ask a question, or type a URL.</p>
</div>`;

const promoBrowser = await chromium.launch({ args: ["--no-sandbox"] });
for (const [name, width, height, title, sub] of [
  ["promo-small-440x280.png", 440, 280, 34, 14],
  ["promo-marquee-1400x560.png", 1400, 560, 76, 26],
]) {
  const page = await promoBrowser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(tile(width, height, title, sub), { waitUntil: "load" });
  await shot(page, name);
  await page.close();
}
await promoBrowser.close();

rmSync(fixture, { recursive: true, force: true });
