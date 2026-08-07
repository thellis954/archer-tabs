// Checks the invariants this repo actually has, which a generic style linter
// would not know about: MV3's CSP rules, the no-innerHTML rule that keeps
// attacker-influenceable page titles inert, the CSS token discipline, and the
// fact that every shipped file must be reachable from the manifest.
//
// Deliberately dependency-free — see docs/ROADMAP.md "Engineering foundation".
// Run: npm run lint

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readPNG, pixelAt } from "./png.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Everything the browser loads lives under extension/; tooling and docs do not.
const EXT = join(ROOT, "extension");
const problems = [];

const fail = (file, msg) => problems.push(`${file}: ${msg}`);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// --- 1. every JS file parses -------------------------------------------------

// Shipped = loaded by the extension page. Tooling is checked for syntax but is
// exempt from the browser-facing rules below, since it never runs in a page.
const SHIPPED_JS = ["extension/newtab.js", "extension/src/classify.js", "extension/src/tlds.js"];
const JS_FILES = [...SHIPPED_JS, "tools/lint.js", "tools/png.js", "tools/genicons.mjs"];

for (const f of JS_FILES) {
  try {
    execFileSync(process.execPath, ["--check", join(ROOT, f)], { stdio: "pipe" });
  } catch (e) {
    fail(f, `syntax error\n${e.stderr?.toString().trim()}`);
  }
}

// --- 2. MV3 forbids inline script and inline handlers on extension pages -----

const html = read("extension/newtab.html");

for (const m of html.matchAll(/<(\w+)[^>]*\son[a-z]+\s*=/gi)) {
  fail("extension/newtab.html", `inline event handler on <${m[1]}> — MV3 CSP blocks it silently`);
}
if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
  fail("extension/newtab.html", "inline <script> body — MV3 CSP blocks it; move it to a file");
}

// --- 3. no HTML injection sinks ---------------------------------------------
// Conversation titles come from chrome.history and are attacker-influenceable.

const SINKS = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/;

for (const f of SHIPPED_JS) {
  read(f)
    .split("\n")
    .forEach((line, i) => {
      if (line.trimStart().startsWith("//")) return;
      const hit = line.match(SINKS);
      if (hit) fail(f, `line ${i + 1}: ${hit[1]} — use textContent instead`);
    });
}

// --- 4. colors live in :root, never in a rule -------------------------------
// A literal hex in a rule body is invisible in one of the two themes.

const css = read("extension/newtab.css");
let depth = 0;
let inRoot = false;
let rootDepth = 0;

css.split("\n").forEach((line, i) => {
  const code = line.replace(/\/\*.*?\*\//g, "");
  if (/:root\s*(,[^{]*)?\{/.test(code) && !inRoot) {
    inRoot = true;
    rootDepth = depth;
  }
  if (!inRoot && /#[0-9a-f]{3,8}\b/i.test(code)) {
    fail("extension/newtab.css", `line ${i + 1}: literal color outside :root — add a token instead`);
  }
  depth += (code.match(/\{/g) || []).length;
  depth -= (code.match(/\}/g) || []).length;
  if (inRoot && depth <= rootDepth) inRoot = false;
});

// --- 5. the manifest and the page agree with the filesystem -----------------

let manifest;
try {
  manifest = JSON.parse(read("extension/manifest.json"));
} catch (e) {
  fail("extension/manifest.json", `invalid JSON: ${e.message}`);
}

if (manifest) {
  const refs = [
    manifest.chrome_url_overrides?.newtab,
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean);

  for (const r of refs) {
    if (!existsSync(join(EXT, r))) fail("extension/manifest.json", `references missing file: ${r}`);
  }
  if (!manifest.icons?.["128"]) {
    fail("extension/manifest.json", "a 128px icon is required for a Web Store listing");
  }
  if (!/^\d+\.\d+(\.\d+)?(\.\d+)?$/.test(manifest.version ?? "")) {
    fail("extension/manifest.json", `version "${manifest.version}" is not a valid extension version`);
  }
}

for (const m of html.matchAll(/(?:src|href)="(?!https?:|data:)([^"]+)"/g)) {
  if (!existsSync(join(EXT, m[1]))) fail("extension/newtab.html", `references missing file: ${m[1]}`);
}

// --- 6. the page's script must be a module, since newtab.js uses import ------

if (/<script\b[^>]*\bsrc="newtab\.js"/.test(html) && !/<script\b[^>]*type="module"[^>]*\bsrc="newtab\.js"/.test(html)) {
  fail("extension/newtab.html", 'newtab.js uses import — its <script> needs type="module"');
}

// --- 7. the generated icons are actually drawn -------------------------------
// The old shell generator shipped icons that were ~60% empty: headless Chromium
// clips its paint to (window height - browser chrome) but writes a screenshot
// the full height of the window. Nothing caught it, because a truncated PNG is
// still a valid PNG of the right dimensions. So look at the pixels.

const ICON_SIZES = [16, 32, 48, 128];
const near = ([r, g, b], [tr, tg, tb], slack = 40) =>
  Math.abs(r - tr) <= slack && Math.abs(g - tg) <= slack && Math.abs(b - tb) <= slack;

const INK = [20, 20, 22];      // the tile
const CREAM = [251, 247, 240]; // the legs
const BRASS = [245, 158, 11];  // the bow

for (const size of ICON_SIZES) {
  const rel = `extension/assets/icon-${size}.png`;
  if (!existsSync(join(ROOT, rel))) {
    fail(rel, "missing — run `npm run icons`");
    continue;
  }

  let img;
  try {
    img = readPNG(join(ROOT, rel));
  } catch (e) {
    fail(rel, e.message);
    continue;
  }

  if (img.width !== size || img.height !== size) {
    fail(rel, `is ${img.width}×${img.height}, but its name promises ${size}×${size}`);
    continue;
  }

  // A rounded tile fills most of its box. Anything far below that means a
  // partial paint — which is exactly the bug this check exists for.
  let opaque = 0;
  let cream = 0;
  let brass = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const px = pixelAt(img, x, y);
      if (px[3] < 128) continue;
      opaque++;
      if (near(px, CREAM)) cream++;
      else if (near(px, BRASS)) brass++;
    }
  }

  const coverage = opaque / (size * size);
  if (coverage < 0.7) {
    fail(rel, `only ${(coverage * 100).toFixed(0)}% of the canvas is painted — a partial render; re-run \`npm run icons\``);
  }
  // The bottom edge is the first thing a clipped render loses.
  if (pixelAt(img, size >> 1, size - 1)[3] < 128) {
    fail(rel, "the bottom edge of the tile is transparent — a clipped render");
  }
  if (cream === 0) fail(rel, "no cream pixels — the mark's legs did not draw");
  if (brass === 0) fail(rel, "no brass pixels — the mark's bowstring did not draw");
}

// --- report ------------------------------------------------------------------

if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length > 1 ? "s" : ""}\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("✓ lint clean");
