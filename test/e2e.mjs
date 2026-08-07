// End-to-end checks against a real Chromium with the unpacked extension loaded.
//
// Not part of `npm test` — it needs a browser, so CI (which installs nothing)
// runs unit tests only. Run locally with: npm run e2e
//
// Requires playwright on the module path:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "extension");

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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok" : "NOT OK"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const ctx = await chromium.launchPersistentContext("", {
  headless: true,
  // Must be the full Chromium build: playwright's default headless *shell*
  // silently ignores --load-extension, and every check then fails to navigate.
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
});

const NEWTAB = `chrome-extension://${extensionId(EXT)}/newtab.html`;

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

await page.goto(NEWTAB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(300);

// Observe where the page tries to go by aborting outbound navigations rather
// than stubbing the page's own APIs: window.location.assign is non-configurable
// in Chrome, and stubbing chrome.search would test the stub instead of the real
// API. An aborted navigation leaves the document intact, so the page survives
// for the next case.
const nav = [];
await page.route(/^https?:/, (route) => {
  const req = route.request();
  if (req.isNavigationRequest()) nav.push(req.url());
  // 204 rather than abort(): a No Content response to a main-frame navigation
  // leaves the current document in place, so one page survives every case.
  // abort() swaps in an error page and every later fill() then times out.
  return route.fulfill({ status: 204, body: "" });
});

// --- the page itself ---------------------------------------------------------

check("extension page loads", page.url().startsWith("chrome-extension://"), page.url());
check("no console or page errors on load", errors.length === 0, errors.join("; "));
check("search input present", (await page.locator("#query").count()) === 1);
check("brand mark rendered", (await page.locator(".brandMark").count()) === 1);
check(
  "stylesheet applied (cream ground, not default white)",
  (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== "rgba(0, 0, 0, 0)",
);

// --- routing -----------------------------------------------------------------

// chrome.search sends the tab to the profile's default engine, which in a fresh
// profile is Google — so a prompt verdict shows up as a search-engine URL and a
// URL verdict shows up as the target itself. Both arrive through `nav`.
const SEARCH_ENGINE = /[?&]q=/;

async function submit(text, mods = []) {
  nav.length = 0;
  await page.fill("#query", text);
  await page.locator("#query").press([...mods, "Enter"].join("+"));
  await page.waitForTimeout(250);
  return nav.slice();
}

const isSearchFor = (urls, text) =>
  urls.length === 1 &&
  SEARCH_ENGINE.test(urls[0]) &&
  decodeURIComponent(urls[0].replace(/\+/g, " ")).includes(text);

let r = await submit("example.com");
check("bare domain navigates to https", r[0]?.startsWith("https://example.com"), JSON.stringify(r));

r = await submit("localhost:3000");
check("localhost keeps http", r[0]?.startsWith("http://localhost:3000"), JSON.stringify(r));

r = await submit("vue.js tutorial");
check("multi-word with a dot searches, not navigates", isSearchFor(r, "vue.js tutorial"), JSON.stringify(r));

r = await submit("node.js");
check("node.js searches, not navigates", isSearchFor(r, "node.js"), JSON.stringify(r));

r = await submit("what is a nock");
check("plain prompt goes to the default engine", isSearchFor(r, "what is a nock"), JSON.stringify(r));

r = await submit("javascript:alert(1)");
check("javascript: URL is searched, never navigated", isSearchFor(r, "javascript:alert(1)"), JSON.stringify(r));

r = await submit("google.com@evil.com");
check(
  "userinfo phishing shape does not navigate",
  !r.some((u) => u.startsWith("https://google.com@")),
  JSON.stringify(r),
);

// --- modifier overrides ------------------------------------------------------

r = await submit("example.com", ["ControlOrMeta"]);
check("Cmd/Ctrl+Enter forces a search", isSearchFor(r, "example.com"), JSON.stringify(r));

r = await submit("intranet", ["Shift"]);
check("Shift+Enter forces navigation", r[0]?.startsWith("https://intranet"), JSON.stringify(r));

// --- escape ------------------------------------------------------------------

await page.fill("#query", "discard me");
await page.locator("#query").press("Escape");
check("Escape clears the input", (await page.inputValue("#query")) === "");

// --- empty submit ------------------------------------------------------------

r = await submit("   ");
check("whitespace-only submit does nothing", r.length === 0, JSON.stringify(r));

await ctx.close();

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
