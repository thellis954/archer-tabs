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

  await ctx.close();
}
