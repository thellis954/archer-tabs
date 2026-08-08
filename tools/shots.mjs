// Screenshot the new tab page in light and dark, from a real Chromium with the
// unpacked extension loaded.
//
// Several bugs in this project were only ever visible in a render — a token
// that resolved to the wrong theme, rows that did not line up under the search
// box. Look at the output before shipping a UI change.
//
// Requires playwright on the module path, same as test/e2e.mjs:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
//
// Usage: npm run shots [outputDir]   (defaults to ./shots, which is gitignored)

import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extension");
const OUT = resolve(process.argv[2] ?? join(ROOT, "shots"));

/** Chrome derives an unpacked extension's id from the SHA-256 of its path. */
function extensionId(absPath) {
  const hex = createHash("sha256").update(absPath).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright not found — see the header of this file");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const NEWTAB = `chrome-extension://${extensionId(EXT)}/newtab.html`;
const VIEWPORTS = [
  { name: "", width: 1280, height: 800 },
  { name: "-narrow", width: 480, height: 720 },
  // The resting page shows neither the armed send control nor a row hover, and
  // both are states a token can get wrong without anything else looking off.
  {
    name: "-active",
    width: 1280,
    height: 800,
    async prepare(page) {
      await page.fill("#query", "what is a nock");
      await page.hover(".suggestions li:first-child .suggestion");
    },
  },
];

for (const scheme of ["light", "dark"]) {
  const ctx = await chromium.launchPersistentContext("", {
    headless: true,
    // Must be the full Chromium build: playwright's default headless *shell*
    // silently ignores --load-extension.
    channel: "chromium",
    colorScheme: scheme,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
  });

  for (const vp of VIEWPORTS) {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(NEWTAB, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(200);
    await vp.prepare?.(page);
    await page.waitForTimeout(150);

    const path = join(OUT, `newtab-${scheme}${vp.name}.png`);
    await page.screenshot({ path });
    console.log(path);
    await page.close();
  }

  // The marketing site ships one of these as web/assets/newtab-<scheme>.png, so
  // generate it here rather than by hand: the version that shipped before this
  // was from Phase 1 and still showed placeholder rows that had been replaced
  // by real ones two phases earlier.
  //
  // Filled and configured rather than at rest. A fresh profile has granted
  // nothing, so the resting page is a clock and an empty box: the favourites
  // bar and the weather card are both opt-in and simply absent. Seeding
  // chrome.storage shows the page someone actually ends up with.
  //
  // The weather reading is written straight into the cache, so no request goes
  // to Open-Meteo and the shot is the same every run. `at` is now, because a
  // stale reading would send dashboard.js looking for a fresh one.
  const site = await ctx.newPage();
  await site.setViewportSize({ width: 1280, height: 800 });
  await site.goto(NEWTAB, { waitUntil: "domcontentloaded" });
  await site.waitForTimeout(200);

  await site.evaluate(() => {
    return chrome.storage.local.set({
      favorites: [
        { id: "https://github.com", url: "https://github.com", name: "GitHub" },
        { id: "https://news.ycombinator.com", url: "https://news.ycombinator.com", name: "Hacker News" },
        { id: "https://developer.mozilla.org", url: "https://developer.mozilla.org", name: "MDN" },
        { id: "https://linear.app", url: "https://linear.app", name: "Linear" },
        { id: "https://figma.com", url: "https://figma.com", name: "Figma" },
      ],
      weatherPlace: { name: "Lisbon", latitude: 38.72, longitude: -9.14 },
      weatherUnit: "celsius",
      weatherCache: {
        place: "Lisbon",
        unit: "celsius",
        temperature: 19,
        text: "Partly cloudy",
        icon: "partly",
        high: 23,
        low: 14,
        at: Date.now(),
      },
      // The default-engine hint is a one-time nudge, not part of the page. It
      // would read as chrome in a marketing shot.
      engineNudgeDismissed: true,
    });
  });

  await site.reload({ waitUntil: "domcontentloaded" });
  await site.waitForTimeout(350);
  await site.fill("#query", "what is a nock");
  await site.waitForTimeout(200);
  const sitePath = join(ROOT, "web", "assets", `newtab-${scheme}.png`);
  await site.screenshot({ path: sitePath, clip: { x: 0, y: 0, width: 1280, height: 700 } });
  console.log(sitePath);
  await site.close();

  // Two widths, because the settings page now has two layouts: a nav column
  // beside the cards, and below 900px the same links as a scrolling strip. The
  // wide one is the one nobody would look at otherwise — 900px is exactly the
  // breakpoint, so a single shot at that size only ever showed the narrow form.
  for (const [name, width] of [["", 1240], ["-narrow", 560]]) {
    const options = await ctx.newPage();
    await options.setViewportSize({ width, height: 900 });
    await options.goto(`chrome-extension://${extensionId(EXT)}/options.html`, { waitUntil: "domcontentloaded" });
    await options.waitForTimeout(250);
    const optionsPath = join(OUT, `options-${scheme}${name}.png`);
    await options.screenshot({ path: optionsPath, fullPage: true });
    console.log(optionsPath);
    await options.close();
  }

  await ctx.close();
}
