// End-to-end checks against a real Chromium with the unpacked extension loaded.
//
// Not part of `npm test` — it needs a browser, so CI (which installs nothing)
// runs unit tests only. Run locally with: npm run e2e
//
// Requires playwright on the module path:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

// --- the send control --------------------------------------------------------

await page.fill("#query", "");
check("send is inert with an empty box", await page.locator("#send").isDisabled());

await page.fill("#query", "   ");
check("send stays inert for whitespace only", await page.locator("#send").isDisabled());

await page.fill("#query", "example.com");
check("send arms once there is something to send", await page.locator("#send").isEnabled());

nav.length = 0;
await page.locator("#send").click();
await page.waitForTimeout(250);
check("clicking send routes the same as Enter", nav[0]?.startsWith("https://example.com"), JSON.stringify(nav));

await page.fill("#query", "gone");
await page.locator("#query").press("Escape");
check("Escape disarms send as well as clearing", await page.locator("#send").isDisabled());

// --- reaching the input without clicking it (§2.4) ---------------------------

async function typeAtPage(key) {
  await page.fill("#query", "");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(key);
  await page.waitForTimeout(80);
  return {
    focused: await page.evaluate(() => document.activeElement?.id),
    value: await page.inputValue("#query"),
  };
}

let t = await typeAtPage("k");
check("a printable key focuses the input and lands in it", t.focused === "query" && t.value === "k", JSON.stringify(t));

t = await typeAtPage("/");
check("slash focuses the input without typing itself", t.focused === "query" && t.value === "", JSON.stringify(t));

t = await typeAtPage("Tab");
check("a non-printable key does not hijack focus", t.focused !== "query", JSON.stringify(t));

// --- accessibility -----------------------------------------------------------

// The description text and the placeholder are normal-size body copy, so they
// owe WCAG AA (4.5:1). This is computed from what the browser actually painted,
// which is the only way to catch a token that regressed in one theme only.
const contrastProbe = () => {
  const luminance = (rgb) => {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const bg = getComputedStyle(document.body).backgroundColor;
  return {
    description: ratio(getComputedStyle(document.querySelector(".description")).color, bg),
    title: ratio(getComputedStyle(document.querySelector(".title")).color, bg),
  };
};

let contrast = await page.evaluate(contrastProbe);
check(
  "light: row descriptions meet AA against the page",
  contrast.description >= 4.5,
  `${contrast.description.toFixed(2)}:1`,
);
check("light: row titles meet AA against the page", contrast.title >= 4.5, `${contrast.title.toFixed(2)}:1`);

check(
  "the big page mark is hidden from assistive tech",
  (await page.locator(".logo[aria-hidden=true]").count()) === 1,
);
const lists = await page.locator(".suggestions").count();
check(
  "every suggestion list is labelled",
  lists > 0 && (await page.locator(".suggestions[aria-label]").count()) === lists,
  `${lists} lists`,
);

const unlabelled = await page.evaluate(() =>
  [...document.querySelectorAll("button")].filter(
    (b) => !b.getAttribute("aria-label") && !b.textContent.trim(),
  ).length,
);
check("every icon-only button has an aria-label", unlabelled === 0, `${unlabelled} without one`);

// --- the mode menu -----------------------------------------------------------

const modeButton = page.locator("#modeButton");
const modeMenu = page.locator("#modeMenu");

check("the menu starts closed", await modeMenu.isHidden());
check("the mode button declares its popup", (await modeButton.getAttribute("aria-haspopup")) === "listbox");

await modeButton.click();
check("clicking the mode button opens the menu", await modeMenu.isVisible());
check("open is announced", (await modeButton.getAttribute("aria-expanded")) === "true");
// Everything below is expressed against the menu as rendered rather than against
// mode names, so adding a destination changes no assertion here.
const modeOrder = await page.locator("#modeMenu [role=option]").evaluateAll((els) =>
  els.map((e) => e.dataset.mode),
);
const selectedAt = await page
  .locator("#modeMenu [role=option]")
  .evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"));

check(
  "the selected option is focused on open",
  (await page.evaluate(() => document.activeElement?.dataset.mode)) === modeOrder[selectedAt],
  await page.evaluate(() => document.activeElement?.dataset.mode),
);

await page.keyboard.press("ArrowDown");
check(
  "ArrowDown walks the options",
  (await page.evaluate(() => document.activeElement?.dataset.mode)) ===
    modeOrder[(selectedAt + 1) % modeOrder.length],
  await page.evaluate(() => document.activeElement?.dataset.mode),
);

// Back to the selected option, then one past the top — which has to wrap rather
// than stick.
for (let i = 0; i <= selectedAt + 1; i++) await page.keyboard.press("ArrowUp");
check(
  "ArrowUp wraps to the last option",
  (await page.evaluate(() => document.activeElement?.dataset.mode)) === modeOrder.at(-1),
  await page.evaluate(() => document.activeElement?.dataset.mode),
);

await page.keyboard.press("Escape");
check("Escape closes the menu", await modeMenu.isHidden());
check("Escape returns focus to the button", await modeButton.evaluate((b) => b === document.activeElement));

// --- routing per mode --------------------------------------------------------

async function chooseMode(mode) {
  await modeButton.click();
  await page.locator(`[role=option][data-mode="${mode}"]`).click();
  await page.waitForTimeout(120);
}

await chooseMode("chatgpt");
check("the button label follows the selection", (await page.locator("#modeLabel").innerText()).trim() === "ChatGPT");
check(
  "the chosen option is the only one marked selected",
  (await page.locator('[role=option][aria-selected="true"]').count()) === 1 &&
    (await page.locator('[role=option][data-mode="chatgpt"]').getAttribute("aria-selected")) === "true",
);

r = await submit("what is a nock");
check(
  "ChatGPT mode sends a prompt to chatgpt.com with the query prefilled",
  r[0] === "https://chatgpt.com/?q=what%20is%20a%20nock",
  JSON.stringify(r),
);

r = await submit("example.com");
check("ChatGPT mode still opens a URL as a URL", r[0]?.startsWith("https://example.com"), JSON.stringify(r));

await chooseMode("search");
r = await submit("example.com");
check("Search mode searches for something that parses as a URL", isSearchFor(r, "example.com"), JSON.stringify(r));

r = await submit("example.com", ["Shift"]);
check("Shift+Enter still overrides Search mode", r[0]?.startsWith("https://example.com"), JSON.stringify(r));

await chooseMode("auto");
r = await submit("example.com");
check("Auto mode navigates again", r[0]?.startsWith("https://example.com"), JSON.stringify(r));

// --- persistence -------------------------------------------------------------

await chooseMode("chatgpt");
const reloaded = await ctx.newPage();
await reloaded.goto(NEWTAB, { waitUntil: "domcontentloaded" });
await reloaded.waitForTimeout(400);
check(
  "the mode survives a new tab",
  (await reloaded.locator("#modeLabel").innerText()).trim() === "ChatGPT",
);

// --- the launch log (ROADMAP §3.3 Source B) ----------------------------------

const readLog = (target) =>
  target.evaluate(() => chrome.storage.local.get({ launches: [] }).then((r) => r.launches));

let log = await readLog(reloaded);
check(
  "prompts launched through the page are logged",
  log.some((e) => e.text === "what is a nock"),
  JSON.stringify(log.slice(-3)),
);
check("each log entry carries a timestamp", log.every((e) => typeof e.at === "number" && e.at > 0));
await reloaded.close();

// A navigate verdict is not a prompt and must never reach the log. Note the
// converse is not "URLs are never logged": in Search mode, and under ⌘+Enter,
// `example.com` *is* a prompt — the user said so — and logging it is right.
await chooseMode("auto");
await submit("never-logged-nav.com");
log = await readLog(page);
check(
  "a navigated URL is never logged",
  !log.some((e) => e.text.includes("never-logged")),
  JSON.stringify(log.slice(-3)),
);

await chooseMode("search");
await submit("logged-as-a-query.com");
log = await readLog(page);
check(
  "the same string in Search mode is logged, because there it is a query",
  log.some((e) => e.text === "logged-as-a-query.com"),
  JSON.stringify(log.slice(-3)),
);
await chooseMode("auto");

// --- the default-engine hint -------------------------------------------------

check("the hint is shown before it is dismissed", await page.locator("#engineNudge").isVisible());
await page.locator("#dismissNudge").click();
await page.waitForTimeout(150);
check("dismissing hides it", await page.locator("#engineNudge").isHidden());

const afterDismiss = await ctx.newPage();
await afterDismiss.goto(NEWTAB, { waitUntil: "domcontentloaded" });
await afterDismiss.waitForTimeout(400);
check("the dismissal sticks across tabs", await afterDismiss.locator("#engineNudge").isHidden());
await afterDismiss.close();

// --- permissions -------------------------------------------------------------

// chrome.tabs.update works on the current tab without the `tabs` permission,
// which gates *reading* a tab's url/title. Navigation above proves the call
// lands; this proves we did not pay for it. See the ledger in docs/ROADMAP.md.
const manifest = await page.evaluate(() => chrome.runtime.getManifest());
check(
  "the manifest asks for no more than search + storage",
  JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(["search", "storage"]),
  JSON.stringify(manifest.permissions),
);
check("no host permissions are requested", !manifest.host_permissions?.length);
check(
  "history is optional, so it is not in the install prompt",
  manifest.optional_permissions?.includes("history") && !manifest.permissions.includes("history"),
  JSON.stringify({ permissions: manifest.permissions, optional: manifest.optional_permissions }),
);

// --- rows, without the history permission ------------------------------------

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);

check("the onboarding row is offered when history is not granted", await page.locator("#onboarding").isVisible());

// Chrome's own wording for `history` is far broader than what Archer does with
// it — "read and change your browsing history on all your signed-in devices" —
// and its popup opens at the top of the window with Deny focused. A user who
// reads that and declines then got no explanation at all, so the click looked
// dead. Both halves are said up front now.
check("the onboarding row says a popup is coming", await page.locator("#historyNote").isVisible());
const historyNote = (await page.locator("#historyNote").innerText()).toLowerCase();
check(
  "...and says where it opens and what its default is",
  historyNote.includes("top of the window") && historyNote.includes("deny"),
  historyNote,
);
check(
  "...and warns that Chrome's wording is broader than what Archer does",
  historyNote.includes("read and change your browsing history"),
  historyNote,
);
check(
  "prompt rows appear with no permission at all",
  (await page.locator("#rows .row.is-prompt").count()) > 0,
  `${await page.locator("#rows .row").count()} rows`,
);
check(
  "no conversation rows without history access",
  (await page.locator("#rows .row.is-conversation").count()) === 0,
);

// Every row's text came from a prompt or a page title. If any of it were ever
// parsed as markup this would find it.
await page.evaluate(() =>
  chrome.storage.local.set({
    launches: [{ text: "<img src=x onerror=alert(1)> & <b>bold</b>", at: Date.now() }],
  }),
);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);
check(
  "row text is inserted as text, never as markup",
  (await page.locator("#rows .row .title").first().innerText()).includes("<img src=x") &&
    (await page.locator("#rows .row").first().evaluate((n) => n.querySelectorAll("img, b").length)) === 0,
);

// --- keyboard through the rows -----------------------------------------------

await page.evaluate(() =>
  chrome.storage.local.set({
    launches: [
      { text: "sourdough starter ratios", at: Date.now() - 3000 },
      { text: "how to fletch an arrow", at: Date.now() - 2000 },
      { text: "tide times for saturday", at: Date.now() - 1000 },
    ],
    dismissed: [],
    pinned: [],
  }),
);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);

const rowTitles = () => page.locator("#rows .row .title").allInnerTexts();
check("all three prompts render", (await rowTitles()).length === 3, JSON.stringify(await rowTitles()));

await page.locator("#query").focus();
await page.keyboard.press("ArrowDown");
check(
  "ArrowDown selects the first row",
  (await page.locator("#rows .row.isActive").count()) === 1 &&
    (await page.locator("#rows .row").first().getAttribute("aria-selected")) === "true",
);
check(
  "the selection is announced on the input",
  (await page.locator("#query").getAttribute("aria-activedescendant")) === "row-0",
);

await page.keyboard.press("ArrowUp");
check("ArrowUp returns to the input", (await page.locator("#rows .row.isActive").count()) === 0);

await page.keyboard.press("ArrowUp");
check(
  "wrapping past the input lands on the last row",
  (await page.locator("#rows .row").last().getAttribute("aria-selected")) === "true",
);

await page.keyboard.press("Escape");
check("Escape drops the selection first", (await page.locator("#rows .row.isActive").count()) === 0);

// --- filtering ---------------------------------------------------------------

await page.fill("#query", "fletch");
await page.waitForTimeout(150);
check(
  "typing filters the rows",
  (await rowTitles()).join("|") === "how to fletch an arrow",
  JSON.stringify(await rowTitles()),
);

await page.fill("#query", "zzzq");
await page.waitForTimeout(150);
check("a query with no matches says so", await page.locator("#noMatches").isVisible());
check("...and does not claim there is nothing at all", await page.locator("#emptyState").isHidden());

await page.fill("#query", "");
await page.waitForTimeout(150);
check("clearing the box brings every row back", (await rowTitles()).length === 3);

// --- relaunching a prompt row ------------------------------------------------

nav.length = 0;
await page.locator("#query").press("ArrowDown");
await page.locator("#query").press("Enter");
await page.waitForTimeout(300);
check(
  "Enter on a selected row re-asks that prompt",
  isSearchFor(nav, "tide times for saturday"),
  JSON.stringify(nav),
);

// --- pin and dismiss ---------------------------------------------------------

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);

await page.locator("#rows .row").last().locator(".pin").click();
await page.waitForTimeout(250);
check(
  "pinning moves a row to the top",
  (await rowTitles())[0] === "sourdough starter ratios",
  JSON.stringify(await rowTitles()),
);
check("a pinned row is marked", (await page.locator("#rows .row.isPinned").count()) === 1);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);
check("the pin survives a reload", (await rowTitles())[0] === "sourdough starter ratios");

await page.locator("#rows .row").first().locator(".dismissRow").click();
await page.waitForTimeout(250);
check(
  "dismissing removes the row",
  !(await rowTitles()).includes("sourdough starter ratios"),
  JSON.stringify(await rowTitles()),
);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);
check("the dismissal survives a reload", (await rowTitles()).length === 2);

// --- the empty state ---------------------------------------------------------

await page.evaluate(() => chrome.storage.local.set({ launches: [], pinned: [], dismissed: [] }));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(400);
// With no permission and nothing logged, the onboarding row *is* the empty
// state — saying "nothing yet" underneath an offer to show something would be
// two answers to one question.
check("with nothing to show, the onboarding row stands alone", await page.locator("#onboarding").isVisible());
check("...and the empty-state line stays out of its way", await page.locator("#emptyState").isHidden());

await ctx.close();

// --- with the history permission granted --------------------------------------
//
// chrome.permissions.request() opens a native dialog that headless Chromium
// never resolves, so the granted path is exercised through a fixture: the same
// extension directory, copied, with `history` moved from optional_permissions
// into permissions so it is granted at install. Same source, same chrome.history
// — only the consent step is skipped, and that step is covered above by
// asserting the onboarding row calls for it.

const fixture = mkdtempSync(join(tmpdir(), "archer-history-"));
cpSync(EXT, fixture, { recursive: true });
{
  const path = join(fixture, "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  // Only `history` — promoting every optional permission would light up top
  // sites too, and this fixture is meant to isolate the conversations path.
  m.permissions = [...m.permissions, "history"];
  m.optional_permissions = m.optional_permissions.filter((p) => p !== "history");
  writeFileSync(path, JSON.stringify(m, null, 2));
}

const histCtx = await chromium.launchPersistentContext("", {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`, "--no-sandbox"],
});
const FIXTURE_NEWTAB = `chrome-extension://${extensionId(fixture)}/newtab.html`;

const CONVOS = [
  { id: "0f9c2a41-1b3d-4c8e-9a77-5e2b6d0c4a19", title: "Evaluate Claude vs rivals", prompt: "compare the coding tools" },
  { id: "7a1e5c93-2d4f-4b6a-8c05-1f3e9b7d2a68", title: "News about Air Quality Alerts", prompt: "why are there air quality alerts" },
];

const seed = await histCtx.newPage();
await seed.goto(FIXTURE_NEWTAB, { waitUntil: "domcontentloaded" });
await seed.waitForTimeout(300);
check("the fixture has history access", await seed.evaluate(() => typeof chrome.history?.search === "function"));

// The launches have to predate the visits for the binding to be able to explain
// them, which is the whole point of §3.3 Source B.
await seed.evaluate(
  (convos) =>
    chrome.storage.local.set({
      launches: convos.map((c, i) => ({ text: c.prompt, at: Date.now() - 20_000 + i })),
      pinned: [],
      dismissed: [],
    }),
  CONVOS,
);

// Real navigations, so Chrome records real titles — the title is the only thing
// that makes a history entry usable as a conversation row.
const browsing = await histCtx.newPage();
await browsing.route(/^https:\/\/chatgpt\.com\//, (r) => {
  const found = CONVOS.find((c) => r.request().url().includes(c.id));
  return r.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8"><title>${found?.title ?? "ChatGPT"}</title><p>x`,
  });
});
for (const convo of CONVOS) {
  await browsing.goto(`https://chatgpt.com/c/${convo.id}`, { waitUntil: "load" });
  await browsing.waitForTimeout(150);
}
// A conversation Chrome only ever saw before it was named. It has to become a
// row anyway — see below.
await browsing.goto("https://chatgpt.com/c/11111111-2222-4333-8444-555555555555", { waitUntil: "load" });
await browsing.waitForTimeout(150);
await browsing.close();

const convoPage = await histCtx.newPage();
await convoPage.goto(FIXTURE_NEWTAB, { waitUntil: "domcontentloaded" });
await convoPage.waitForTimeout(700);

check("the onboarding row is gone once access is granted", await convoPage.locator("#onboarding").isHidden());

const convoTitles = await convoPage.locator("#rows .row.is-conversation .title").allInnerTexts();
check(
  "recent conversations render, titled from history",
  CONVOS.every((c) => convoTitles.includes(c.title)),
  JSON.stringify(convoTitles),
);
// This assertion used to be the opposite, and it was the bug. Chrome stores the
// title as it was when the address was pushed — which for a single-page app is
// before the model has named the chat — and never revises it. Dropping those
// rows made the whole feature look like it pulled nothing: real history, real
// search results, zero rows. Reachable beats well-named.
check(
  "a conversation Chrome never named is still offered, under its provider's name",
  convoTitles.includes("ChatGPT conversation"),
  JSON.stringify(convoTitles),
);
check(
  "...and is never left showing the bare product name",
  !convoTitles.some((t) => t.trim().toLowerCase() === "chatgpt"),
  JSON.stringify(convoTitles),
);

// Pairing, not just presence: the launches here are fired in a burst before
// any conversation resolves, which is exactly the case where a "nearest
// timestamp" rule pairs everything backwards.
const paired = await convoPage.locator("#rows .row.is-conversation").evaluateAll((rows) =>
  Object.fromEntries(
    rows.map((r) => [r.querySelector(".title").textContent, r.querySelector(".description").textContent]),
  ),
);
check(
  "each conversation gets the prompt that actually started it",
  CONVOS.every((c) => paired[c.title] === `— ChatGPT · ${c.prompt}`),
  JSON.stringify(paired),
);
// Opening it is the entire point of keeping it.
const namelessRow = convoPage.locator("#rows .row.is-conversation", { hasText: "ChatGPT conversation" });
check("the nameless conversation is a real, clickable row", (await namelessRow.count()) === 1);

check(
  "a bound launch does not also appear as its own ask-again row",
  (await convoPage.locator("#rows .row.is-prompt").count()) === 0,
  `${await convoPage.locator("#rows .row.is-prompt").count()} prompt rows`,
);

// Opening a row must go to the conversation, and to a URL rebuilt from the id.
const convoNav = [];
await convoPage.route(/^https?:/, (r) => {
  if (r.request().isNavigationRequest()) convoNav.push(r.request().url());
  return r.fulfill({ status: 204, body: "" });
});
await convoPage.locator("#rows .row.is-conversation").first().click();
await convoPage.waitForTimeout(300);
check(
  "clicking a conversation opens it",
  /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}$/.test(convoNav[0] ?? ""),
  JSON.stringify(convoNav),
);

// The real empty state: access granted, but nothing found.
await convoPage.evaluate(() =>
  chrome.storage.local.set({ launches: [], pinned: [], dismissed: [] }).then(() =>
    chrome.history.deleteAll(),
  ),
);
await convoPage.reload({ waitUntil: "domcontentloaded" });
await convoPage.waitForTimeout(500);
check("granted but empty gets a real empty state", await convoPage.locator("#emptyState").isVisible());

await histCtx.close();
rmSync(fixture, { recursive: true, force: true });

// --- inline answers ------------------------------------------------------------
//
// Same fixture trick, for the same reason: reaching api.openai.com needs an
// optional host permission, and the grant dialog never resolves headless. The
// API itself is stubbed — this checks Archer's half of the exchange (framing,
// accounting, the budget, cancellation), not OpenAI's.

const answerFixture = mkdtempSync(join(tmpdir(), "archer-answer-"));
cpSync(EXT, answerFixture, { recursive: true });
{
  const path = join(answerFixture, "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  m.host_permissions = m.optional_host_permissions;
  delete m.optional_host_permissions;
  writeFileSync(path, JSON.stringify(m, null, 2));
}

const answerCtx = await chromium.launchPersistentContext("", {
  headless: true,
  channel: "chromium",
  args: [
    `--disable-extensions-except=${answerFixture}`,
    `--load-extension=${answerFixture}`,
    "--no-sandbox",
  ],
});
const ANSWER_NEWTAB = `chrome-extension://${extensionId(answerFixture)}/newtab.html`;

const sse = (parts, usage) =>
  parts.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join("") +
  `data: ${JSON.stringify({ choices: [], usage })}\n\n` +
  "data: [DONE]\n\n";

let apiCalls = 0;
let apiBody = null;

const answerPage = await answerCtx.newPage();
await answerPage.route("https://api.openai.com/**", async (r) => {
  apiCalls++;
  apiBody = JSON.parse(r.request().postData() ?? "null");
  return r.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: sse(["A nock ", "is the slot ", "at the arrow's end."], {
      prompt_tokens: 12,
      completion_tokens: 30,
      total_tokens: 42,
    }),
  });
});
await answerPage.goto(ANSWER_NEWTAB, { waitUntil: "domcontentloaded" });
await answerPage.waitForTimeout(300);

// No key yet: answer mode must not break, it must fall back.
await answerPage.evaluate(() =>
  chrome.storage.local.set({ mode: "answer", apiKey: "", model: "", engineNudgeDismissed: true }),
);
await answerPage.goto(ANSWER_NEWTAB, { waitUntil: "domcontentloaded" });
await answerPage.waitForTimeout(400);

const answerNav = [];
await answerPage.route(/^https?:(?!\/\/api\.openai\.com)/, (r) => {
  if (r.request().isNavigationRequest()) answerNav.push(r.request().url());
  return r.fulfill({ status: 204, body: "" });
});

async function ask(text) {
  answerNav.length = 0;
  await answerPage.fill("#query", text);
  await answerPage.locator("#query").press("Enter");
  await answerPage.waitForTimeout(600);
}

await ask("what is a nock");
check(
  "answer mode with no key falls back to a search",
  answerNav.some((u) => /[?&]q=/.test(u)),
  JSON.stringify(answerNav),
);
check("...and nothing was sent to the API", apiCalls === 0, `${apiCalls} calls`);
check("...and no answer panel appeared", await answerPage.locator("#answer").isHidden());

// Now with a key.
await answerPage.evaluate(() =>
  chrome.storage.local.set({ mode: "answer", apiKey: "sk-test", model: "test-model", tokenCap: 50000, spend: null }),
);
await answerPage.goto(ANSWER_NEWTAB, { waitUntil: "domcontentloaded" });
await answerPage.waitForTimeout(400);

await ask("what is a nock");
check("the answer streams onto the page", apiCalls === 1, `${apiCalls} calls`);
check(
  "the streamed text is assembled in order",
  (await answerPage.locator("#answerText").innerText()) === "A nock is the slot at the arrow's end.",
  await answerPage.locator("#answerText").innerText(),
);
check("the request carries the chosen model", apiBody?.model === "test-model", JSON.stringify(apiBody?.model));
check("...and asks for usage, or the counter has nothing exact", apiBody?.stream_options?.include_usage === true);
const statusText = () => answerPage.locator("#answerStatus").evaluate((n) => n.textContent);
check("completion is announced", (await statusText()).includes("complete"), await statusText());
check(
  "the token count is reported",
  (await answerPage.locator("#answerMeta").innerText()).includes("42 tokens"),
  await answerPage.locator("#answerMeta").innerText(),
);
check(
  "the prompt is still logged, so it shows up in recall",
  await answerPage.evaluate(() =>
    chrome.storage.local.get({ launches: [] }).then((r) => r.launches.some((l) => l.text === "what is a nock")),
  ),
);
check(
  "spend accumulates for the day",
  await answerPage.evaluate(() => chrome.storage.local.get({ spend: null }).then((r) => r.spend?.tokens)) === 42,
);

// Whatever the model returns is text. If any of it were parsed, this would say so.
await answerPage.unroute("https://api.openai.com/**");
await answerPage.route("https://api.openai.com/**", (r) =>
  r.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: sse(["<img src=x onerror=alert(1)>", "<b>bold</b>"], { total_tokens: 5 }),
  }),
);
await ask("give me some html");
check(
  "the answer is rendered as text, never as markup",
  (await answerPage.locator("#answerText").innerText()).includes("<img src=x") &&
    (await answerPage.locator("#answerText").evaluate((n) => n.querySelectorAll("img, b").length)) === 0,
);

// An API error has to say what went wrong, not fail silently.
await answerPage.unroute("https://api.openai.com/**");
await answerPage.route("https://api.openai.com/**", (r) =>
  r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { message: "Incorrect API key provided." } }) }),
);
await ask("this will fail");
check(
  "an API error surfaces the API's own message",
  (await answerPage.locator("#answerMeta").innerText()).includes("Incorrect API key"),
  await answerPage.locator("#answerMeta").innerText(),
);

// The budget has to actually stop it.
await answerPage.evaluate(() =>
  chrome.storage.local.set({ tokenCap: 100, spend: { day: new Date().toISOString().slice(0, 10), tokens: 500 } }),
);
await answerPage.goto(ANSWER_NEWTAB, { waitUntil: "domcontentloaded" });
await answerPage.waitForTimeout(400);
const callsBeforeCap = apiCalls;
await ask("over budget");
check("the daily budget stops the request", apiCalls === callsBeforeCap, `${apiCalls - callsBeforeCap} calls got through`);
check(
  "...and says so rather than failing quietly",
  (await statusText()).includes("budget"),
  await statusText(),
);

// --- the options page ----------------------------------------------------------

const optionsPage = await answerCtx.newPage();
await optionsPage.route("https://api.openai.com/v1/models", (r) =>
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }),
  }),
);
await optionsPage.goto(`chrome-extension://${extensionId(answerFixture)}/options.html`, {
  waitUntil: "domcontentloaded",
});
await optionsPage.waitForTimeout(300);

check("the options page loads", (await optionsPage.locator("#apiKey").count()) === 1);
check("the key field is a password field", (await optionsPage.locator("#apiKey").getAttribute("type")) === "password");

await optionsPage.fill("#apiKey", "");
await optionsPage.locator("#saveKey").click();
await optionsPage.waitForTimeout(200);
check(
  "saving an empty key is refused",
  (await optionsPage.locator("#keyStatus").innerText()).includes("Paste a key"),
);

await optionsPage.fill("#apiKey", "sk-another");
await optionsPage.locator("#saveKey").click();
await optionsPage.waitForTimeout(500);
check(
  "a key is validated against the API before it is stored",
  (await optionsPage.locator("#keyStatus").innerText()).includes("2 models"),
  await optionsPage.locator("#keyStatus").innerText(),
);
check(
  "the model list comes from the key, not from a hardcoded list",
  (await optionsPage.locator("#model option").allInnerTexts()).join(",") === "model-a,model-b",
);

await optionsPage.locator("#clearKey").click();
await optionsPage.waitForTimeout(250);
check(
  "clearing the key removes it from storage",
  (await optionsPage.evaluate(() => chrome.storage.local.get({ apiKey: "x" }).then((r) => r.apiKey))) === "",
);

await answerCtx.close();
rmSync(answerFixture, { recursive: true, force: true });

// --- Phase 5: power features ----------------------------------------------------

const powerFixture = mkdtempSync(join(tmpdir(), "archer-power-"));
cpSync(EXT, powerFixture, { recursive: true });
{
  // topSites and sessions are optional, and the grant dialog never resolves
  // headless — same fixture trick as history and api.openai.com.
  const path = join(powerFixture, "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  m.permissions = [...m.permissions, "topSites", "sessions", "tabs"];
  m.optional_permissions = m.optional_permissions.filter(
    (p) => !["topSites", "sessions", "tabs"].includes(p),
  );
  writeFileSync(path, JSON.stringify(m, null, 2));
}

const powerCtx = await chromium.launchPersistentContext("", {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${powerFixture}`, `--load-extension=${powerFixture}`, "--no-sandbox"],
});
const POWER_NEWTAB = `chrome-extension://${extensionId(powerFixture)}/newtab.html`;

// A closed tab we control, so the row below has a known title and a known link
// target. Chrome's own top-sites list in a fresh profile is only the Web Store,
// which extensions are forbidden to navigate to — clicking that row kills the
// renderer, which is how this was found.
const doomed = await powerCtx.newPage();
await doomed.route(/^https?:/, (r) =>
  r.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><meta charset=utf-8><title>Fletching guide</title><p>x",
  }),
);
await doomed.goto("https://example.com/fletching", { waitUntil: "load" });
await doomed.waitForTimeout(200);
await doomed.close();

const power = await powerCtx.newPage();
await power.goto(POWER_NEWTAB, { waitUntil: "domcontentloaded" });
await power.waitForTimeout(300);

await power.evaluate(() =>
  chrome.storage.local.set({
    engineNudgeDismissed: true,
    mode: "auto",
    pinned: [],
    dismissed: [],
    launches: [{ text: "sourdough starter ratios", at: Date.now() - 1000 }],
    library: [
      { id: "t1", name: "translate", text: "Translate {{text}} into {{language}}" },
      { id: "t2", name: "review", text: "Review this code for bugs" },
    ],
  }),
);
await power.goto(POWER_NEWTAB, { waitUntil: "domcontentloaded" });
await power.waitForTimeout(500);

const powerNav = [];
await power.route(/^https?:/, (r) => {
  if (r.request().isNavigationRequest()) powerNav.push(r.request().url());
  return r.fulfill({ status: 204, body: "" });
});

async function powerSubmit(text, mods = []) {
  powerNav.length = 0;
  await power.fill("#query", text);
  await power.locator("#query").press([...mods, "Enter"].join("+"));
  await power.waitForTimeout(250);
  return powerNav.slice();
}

// --- multi-target routing -------------------------------------------------------

async function pickMode(mode) {
  await power.locator("#modeButton").click();
  await power.locator(`#modeMenu [role=option][data-mode="${mode}"]`).click();
  await power.waitForTimeout(150);
}

await pickMode("claude");
let out = await powerSubmit("what is a nock");
check(
  "Claude mode hands the prompt to claude.ai",
  out[0] === "https://claude.ai/new?q=what%20is%20a%20nock",
  JSON.stringify(out),
);

await pickMode("perplexity");
out = await powerSubmit("what is a nock");
check(
  "Perplexity mode hands the prompt to perplexity.ai",
  out[0] === "https://www.perplexity.ai/search?q=what%20is%20a%20nock",
  JSON.stringify(out),
);

out = await powerSubmit("example.com");
check("a URL still opens in a hand-off mode", out[0]?.startsWith("https://example.com"), JSON.stringify(out));

// Alt+arrow cycles the target without going near the menu.
await pickMode("auto");
// The label after Auto in the menu, rather than a name: the point of the check
// is that Alt+arrow moves one step, not which destination happens to be next.
const nextLabel = await power.locator("#modeMenu [role=option]").nth(1).getAttribute("data-label");
await power.fill("#query", "x");
await power.locator("#query").press("Alt+ArrowDown");
await power.waitForTimeout(150);
check(
  "Alt+ArrowDown cycles to the next target",
  (await power.locator("#modeLabel").innerText()).trim() === nextLabel,
  `${await power.locator("#modeLabel").innerText()} (wanted ${nextLabel})`,
);

await power.locator("#query").press("Alt+ArrowUp");
await power.waitForTimeout(150);
check("Alt+ArrowUp cycles back", (await power.locator("#modeLabel").innerText()).trim() === "Auto");

await power.fill("#query", ""); // "x" from the cycle check above matches no row
await power.locator("#query").press("ArrowDown");
await power.waitForTimeout(120);
check(
  "a plain ArrowDown still walks the rows rather than the modes",
  (await power.locator("#modeLabel").innerText()).trim() === "Auto" &&
    (await power.locator("#rows .row.isActive").count()) === 1,
);
await power.locator("#query").press("Escape");

// --- the prompt library ----------------------------------------------------------

await power.fill("#query", "/");
await power.waitForTimeout(200);
check(
  "a leading slash lists the saved prompts",
  (await power.locator("#rows .row.is-template .title").allInnerTexts()).join("|") === "translate|review",
  JSON.stringify(await power.locator("#rows .row .title").allInnerTexts()),
);

await power.fill("#query", "/rev");
await power.waitForTimeout(200);
check(
  "typing after the slash filters them",
  (await power.locator("#rows .row .title").allInnerTexts()).join("|") === "review",
);

await power.fill("#query", "and/or something");
await power.waitForTimeout(200);
check(
  "a slash that is not leading is just text",
  (await power.locator("#rows .row.is-template").count()) === 0,
);

await power.fill("#query", "/translate");
await power.waitForTimeout(200);
await power.locator("#query").press("ArrowDown");
await power.locator("#query").press("Enter");
await power.waitForTimeout(250);

check(
  "choosing a saved prompt puts its text in the box",
  (await power.inputValue("#query")) === "Translate {{text}} into {{language}}",
  await power.inputValue("#query"),
);

const selection = () =>
  power.locator("#query").evaluate((n) => n.value.slice(n.selectionStart, n.selectionEnd));
check("...with the first blank selected to type over", (await selection()) === "{{text}}", await selection());

await power.locator("#query").press("Tab");
await power.waitForTimeout(120);
check("Tab moves to the next blank", (await selection()) === "{{language}}", await selection());

await power.keyboard.type("French");
await power.waitForTimeout(120);
check(
  "typing replaces the selected blank",
  (await power.inputValue("#query")) === "Translate {{text}} into French",
  await power.inputValue("#query"),
);

// Tab has to stay Tab once the blanks are gone, or the box traps keyboard users.
await power.fill("#query", "no blanks here");
await power.locator("#query").press("Tab");
await power.waitForTimeout(120);
check(
  "Tab leaves the field when there is no blank left",
  await power.evaluate(() => document.activeElement?.id !== "query"),
);

// --- the + menu -------------------------------------------------------------------

await power.locator("#plusButton").click();
await power.waitForTimeout(150);
check("the + button opens a menu", await power.locator("#plusMenu").isVisible());
check("...announced as a menu", (await power.locator("#plusButton").getAttribute("aria-haspopup")) === "menu");
check(
  "...whose items are menuitems, not options — it has no selection to claim",
  (await power.locator("#plusMenu [role=menuitem]").count()) === 6 &&
    (await power.locator("#plusMenu [role=option]").count()) === 0,
);

await power.locator('#plusMenu [data-action="library"]').click();
await power.waitForTimeout(250);
check(
  "the Saved prompts item opens the library in the box",
  (await power.inputValue("#query")) === "/" &&
    (await power.locator("#rows .row.is-template").count()) === 2,
);

// --- top sites and closed tabs ----------------------------------------------------

await power.fill("#query", "");
await power.locator("#plusButton").click();
await power.locator('#plusMenu [data-action="tiles"]').click();
await power.waitForTimeout(500);
await power.locator("#plusButton").click();
await power.locator('#plusMenu [data-action="closed"]').click();
await power.waitForTimeout(700);

check(
  "top sites and closed tabs are separate opt-ins",
  (await power.locator('#plusMenu [data-action="tiles"]').count()) === 1 &&
    (await power.locator('#plusMenu [data-action="closed"]').count()) === 1,
);

const kinds = await power.locator("#rows .row").evaluateAll((rows) => rows.map((r) => r.dataset.kind));
check("recently closed tabs join the rows once enabled", kinds.includes("closed"), JSON.stringify(kinds));
check("a prompt still outranks them", kinds.indexOf("prompt") === 0, JSON.stringify(kinds));

// Chrome's only default top site in a fresh profile is the Web Store, which an
// extension is forbidden to navigate to — clicking that row killed the
// renderer. It must never be offered.
const rowTitlesNow = await power.locator("#rows .row .title").allInnerTexts();
check(
  "the Web Store is never offered as a row — extensions cannot navigate to it",
  !rowTitlesNow.some((t) => /web store/i.test(t)),
  JSON.stringify(rowTitlesNow),
);
check(
  "top sites really were granted",
  await power.evaluate(() => chrome.permissions.contains({ permissions: ["topSites"] })),
);

const closedRow = power.locator("#rows .row.is-closed").first();
check(
  "a closed tab carries the title Chrome recorded",
  (await closedRow.locator(".title").innerText()) === "Fletching guide",
  await closedRow.locator(".title").innerText(),
);

powerNav.length = 0;
await closedRow.click();
await power.waitForTimeout(300);
check(
  "clicking it reopens that page",
  powerNav[0] === "https://example.com/fletching",
  JSON.stringify(powerNav),
);

// --- the options page: library, analytics, export ---------------------------------

const powerOptions = await powerCtx.newPage();
await powerOptions.goto(`chrome-extension://${extensionId(powerFixture)}/options.html`, {
  waitUntil: "domcontentloaded",
});
await powerOptions.waitForTimeout(400);

check(
  "saved prompts are listed with their blanks",
  (await powerOptions.locator(".template .templateName").allInnerTexts()).join("|") === "/translate|/review",
  JSON.stringify(await powerOptions.locator(".template .templateName").allInnerTexts()),
);
check(
  "...and the blanks are named",
  (await powerOptions.locator(".template").first().locator(".templateMeta").innerText()).includes("{{text}}"),
);

await powerOptions.fill("#templateName", "Two Words");
await powerOptions.fill("#templateText", "A prompt about {{thing}}");
await powerOptions.locator("#addTemplate").click();
await powerOptions.waitForTimeout(250);
check(
  "a name with spaces is normalised so it can be typed after a slash",
  (await powerOptions.locator(".template .templateName").allInnerTexts()).includes("/two-words"),
  JSON.stringify(await powerOptions.locator(".template .templateName").allInnerTexts()),
);

await powerOptions.fill("#templateName", "review");
await powerOptions.fill("#templateText", "Review this for security bugs");
await powerOptions.locator("#addTemplate").click();
await powerOptions.waitForTimeout(250);
check(
  "saving an existing name updates rather than duplicates",
  (await powerOptions.locator(".template").count()) === 3,
  `${await powerOptions.locator(".template").count()} templates`,
);

await powerOptions.fill("#templateName", "");
await powerOptions.fill("#templateText", "");
await powerOptions.locator("#addTemplate").click();
await powerOptions.waitForTimeout(200);
check(
  "an incomplete saved prompt is refused",
  (await powerOptions.locator("#templateStatus").innerText()).includes("needs both"),
);

check(
  "the analytics panel reports what was asked",
  (await powerOptions.locator(".stats").count()) === 1 &&
    (await powerOptions.locator(".words li").allInnerTexts()).some((t) => t.startsWith("sourdough")),
  JSON.stringify(await powerOptions.locator(".words li").allInnerTexts()),
);

const download = powerOptions.waitForEvent("download", { timeout: 5000 }).catch(() => null);
await powerOptions.locator("#exportMarkdown").click();
const file = await download;
check("the Markdown export downloads", Boolean(file), file ? file.suggestedFilename() : "no download event");
if (file) {
  check(
    "...named for the day it was taken",
    /^archer-prompts-\d{4}-\d{2}-\d{2}\.md$/.test(file.suggestedFilename()),
    file.suggestedFilename(),
  );
}

await powerOptions.locator("#clearHistory").click();
await powerOptions.waitForTimeout(300);
check(
  "clearing prompt history empties the log",
  (await powerOptions.evaluate(() =>
    chrome.storage.local.get({ launches: ["x"] }).then((r) => r.launches.length),
  )) === 0,
);
check(
  "...but leaves the saved prompts alone",
  (await powerOptions.locator(".template").count()) === 3,
);

await powerCtx.close();
rmSync(powerFixture, { recursive: true, force: true });

// --- Phase 6: the dashboard -------------------------------------------------------

const dashFixture = mkdtempSync(join(tmpdir(), "archer-dash-"));
cpSync(EXT, dashFixture, { recursive: true });
{
  // Open-Meteo is an optional host permission; the grant dialog never resolves
  // headless, so the fixture holds it outright.
  const path = join(dashFixture, "manifest.json");
  const m = JSON.parse(readFileSync(path, "utf8"));
  m.host_permissions = m.optional_host_permissions.filter((o) => o.includes("open-meteo"));
  m.optional_host_permissions = m.optional_host_permissions.filter((o) => !o.includes("open-meteo"));
  // Same reason for `favicon`: its dialog never resolves headless either, and
  // what is under test is the fallback, not Chrome's consent UI.
  m.permissions = [...m.permissions, "favicon"];
  m.optional_permissions = m.optional_permissions.filter((x) => x !== "favicon");
  writeFileSync(path, JSON.stringify(m, null, 2));
}

const dashCtx = await chromium.launchPersistentContext("", {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${dashFixture}`, `--load-extension=${dashFixture}`, "--no-sandbox"],
});
const DASH_NEWTAB = `chrome-extension://${extensionId(dashFixture)}/newtab.html`;

const dash = await dashCtx.newPage();
await dash.route("https://geocoding-api.open-meteo.com/**", (r) =>
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      results: [{ name: "Brighton", admin1: "England", country_code: "GB", latitude: 50.82, longitude: -0.14 }],
    }),
  }),
);
await dash.route("https://api.open-meteo.com/**", (r) =>
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      current: { temperature_2m: 21.6, weather_code: 2 },
      daily: { temperature_2m_max: [28.9], temperature_2m_min: [19.5] },
    }),
  }),
);

await dash.goto(DASH_NEWTAB, { waitUntil: "domcontentloaded" });
await dash.waitForTimeout(400);

// --- clock ---------------------------------------------------------------------

check(
  "the clock shows a time",
  /\d{1,2}[:.]\d{2}/.test(await dash.locator("#clockTime").innerText()),
  await dash.locator("#clockTime").innerText(),
);
check(
  "...a greeting",
  /^Good (morning|afternoon|evening|night)$/.test(await dash.locator("#clockGreeting").innerText()),
  await dash.locator("#clockGreeting").innerText(),
);
check(
  "...and a date with the zone",
  (await dash.locator("#clockDate").innerText()).includes("·"),
  await dash.locator("#clockDate").innerText(),
);

// --- weather ---------------------------------------------------------------------

check("the weather card is hidden until a place is set", await dash.locator("#weather").isHidden());

const dashOptions = await dashCtx.newPage();
await dashOptions.route("https://geocoding-api.open-meteo.com/**", (r) =>
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      results: [{ name: "Brighton", admin1: "England", country_code: "GB", latitude: 50.82, longitude: -0.14 }],
    }),
  }),
);
await dashOptions.route("https://api.open-meteo.com/**", (r) =>
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      current: { temperature_2m: 21.6, weather_code: 2 },
      daily: { temperature_2m_max: [28.9], temperature_2m_min: [19.5] },
    }),
  }),
);
await dashOptions.goto(`chrome-extension://${extensionId(dashFixture)}/options.html`, {
  waitUntil: "domcontentloaded",
});
await dashOptions.waitForTimeout(300);

await dashOptions.locator("#savePlace").click();
await dashOptions.waitForTimeout(200);
check(
  "saving an empty place is refused",
  (await dashOptions.locator("#placeStatus").innerText()).includes("town or city"),
);

await dashOptions.fill("#place", "Brighton");
await dashOptions.locator("#savePlace").click();
await dashOptions.waitForTimeout(600);
check(
  "a place is resolved and confirmed",
  (await dashOptions.locator("#placeStatus").innerText()).includes("Brighton, England, GB"),
  await dashOptions.locator("#placeStatus").innerText(),
);

await dash.reload({ waitUntil: "domcontentloaded" });
await dash.waitForTimeout(600);

check("the weather card appears once a place is set", await dash.locator("#weather").isVisible());
check(
  "...with the temperature rounded",
  (await dash.locator("#weatherTemp").innerText()) === "22°C",
  await dash.locator("#weatherTemp").innerText(),
);
check(
  "...the condition named",
  (await dash.locator("#weatherText").innerText()) === "Partly cloudy",
  await dash.locator("#weatherText").innerText(),
);
check(
  "...and the day's range",
  (await dash.locator("#weatherRange").innerText()) === "H:29° L:20°",
  await dash.locator("#weatherRange").innerText(),
);
check("the card carries an icon", (await dash.locator("#weatherIcon svg").count()) === 1);

await dashOptions.locator("#clearPlace").click();
await dashOptions.waitForTimeout(300);
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.waitForTimeout(500);
check("turning weather off removes the card", await dash.locator("#weather").isHidden());

// --- target pills ------------------------------------------------------------------

await dash.evaluate(() => chrome.storage.local.set({ mode: "google", engineNudgeDismissed: true, favorites: [] }));
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.waitForTimeout(400);

const pressed = () =>
  dash.locator('.target[aria-pressed="true"]').evaluateAll((els) => els.map((e) => e.dataset.mode));

check("exactly one pill is pressed at a time", (await pressed()).length === 1, JSON.stringify(await pressed()));
check("...and it matches the stored mode", (await pressed())[0] === "google");

await dash.locator('.target[data-mode="claude"]').click();
await dash.waitForTimeout(200);
check("clicking a pill selects it", (await pressed())[0] === "claude", JSON.stringify(await pressed()));
check(
  "...and the top-bar menu follows, since both are one setting",
  (await dash.locator("#modeLabel").innerText()).trim() === "Claude",
);

await dash.bringToFront();

const dashNav = [];
await dash.route(/^https?:(?!\/\/(api|geocoding-api)\.open-meteo)/, (r) => {
  if (r.request().isNavigationRequest()) dashNav.push(r.request().url());
  return r.fulfill({ status: 204, body: "" });
});

await dash.fill("#query", "what is a nock");
await dash.locator("#query").press("Enter");
await dash.waitForTimeout(300);
check(
  "the pill actually routes the query",
  dashNav[0] === "https://claude.ai/new?q=what%20is%20a%20nock",
  JSON.stringify(dashNav),
);

// Choosing in the menu has to move the pill back the other way.
await dash.locator("#modeButton").click();
await dash.locator('#modeMenu [role=option][data-mode="chatgpt"]').click();
await dash.waitForTimeout(200);
check("choosing in the menu moves the pill", (await pressed())[0] === "chatgpt", JSON.stringify(await pressed()));

check(
  "all four destinations have a pill",
  (await dash.locator(".target").evaluateAll((els) => els.map((e) => e.dataset.mode))).join() ===
    "google,chatgpt,claude,perplexity",
  JSON.stringify(await dash.locator(".target").evaluateAll((els) => els.map((e) => e.dataset.mode))),
);

// The pill labelled Google used to be data-mode="auto", which hands prompts to
// chrome.search — the user's *default* engine. Anyone who had made ChatGPT their
// default got ChatGPT from a button that said Google. A pill naming a place has
// to reach that place.
check(
  "the pill labelled Google says Google",
  (await dash.locator('.target[data-mode="google"]').innerText()).trim() === "Google",
  await dash.locator('.target[data-mode="google"]').innerText(),
);

await dash.locator('.target[data-mode="google"]').click();
await dash.waitForTimeout(200);
dashNav.length = 0;
await dash.fill("#query", "submit an extension to the chrome store");
await dash.locator("#query").press("Enter");
await dash.waitForTimeout(400);
check(
  "the Google pill reaches Google, not the default engine",
  (dashNav[0] ?? "").startsWith("https://www.google.com/search?q=submit"),
  JSON.stringify(dashNav),
);

dashNav.length = 0;
await dash.fill("#query", "example.com");
await dash.locator("#query").press("Enter");
await dash.waitForTimeout(400);
check(
  "...and a URL still just opens in Google mode",
  (dashNav[0] ?? "").startsWith("https://example.com"),
  JSON.stringify(dashNav),
);
await dash.fill("#query", "");

// A mode with no pill leaves them all unpressed rather than lying about one.
await dash.locator("#modeButton").click();
await dash.locator('#modeMenu [role=option][data-mode="search"]').click();
await dash.waitForTimeout(200);
check("a mode with no pill presses none of them", (await pressed()).length === 0, JSON.stringify(await pressed()));

// The default is one setting reachable from two places.
await dashOptions.reload({ waitUntil: "domcontentloaded" });
await dashOptions.waitForTimeout(300);
check(
  "settings shows the destination the page is using",
  (await dashOptions.locator("#defaultMode").inputValue()) === "search",
  await dashOptions.locator("#defaultMode").inputValue(),
);

await dashOptions.selectOption("#defaultMode", "perplexity");
await dashOptions.waitForTimeout(250);
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.bringToFront();
await dash.waitForTimeout(400);
check(
  "changing the default there changes what a new tab uses",
  (await pressed())[0] === "perplexity",
  JSON.stringify(await pressed()),
);

// --- favorites ----------------------------------------------------------------------

await dash.locator("#modeButton").click();
await dash.locator('#modeMenu [role=option][data-mode="auto"]').click();
await dash.waitForTimeout(200);

check("the favorites bar says when it is empty", await dash.locator("#favoritesEmpty").isVisible());
check("the add form starts closed", await dash.locator("#addTileForm").isHidden());

await dash.locator("#addFavorite").click();
await dash.waitForTimeout(150);
check("Add opens the form", await dash.locator("#addTileForm").isVisible());

await dash.fill("#tileUrl", "javascript:alert(1)");
await dash.locator(".tileSave").click();
await dash.waitForTimeout(250);
check(
  "a javascript: favorite is refused",
  (await dash.locator("#tileStatus").innerText()).includes("web address") &&
    (await dash.locator(".tile").count()) === 0,
  await dash.locator("#tileStatus").innerText(),
);

await dash.fill("#tileUrl", "github.com");
await dash.locator(".tileSave").click();
await dash.waitForTimeout(300);
check("a bare host becomes a tile", (await dash.locator(".tile").count()) === 1);
check(
  "...named from the site",
  (await dash.locator(".tileName").innerText()) === "Github",
  await dash.locator(".tileName").innerText(),
);
check(
  "...with a monogram face",
  (await dash.locator(".tileFace").innerText()) === "GI",
  await dash.locator(".tileFace").innerText(),
);
check("...and the empty line goes away", await dash.locator("#favoritesEmpty").isHidden());

await dash.locator("#addFavorite").click();
await dash.fill("#tileUrl", "youtube.com");
await dash.fill("#tileName", "YouTube");
await dash.locator(".tileSave").click();
await dash.waitForTimeout(300);
check("a given name is kept", (await dash.locator(".tileName").allInnerTexts()).includes("YouTube"));
check(
  "...and drives the monogram",
  (await dash.locator(".tile").last().locator(".tileFace").innerText()) === "YT",
);

dashNav.length = 0;
await dash.bringToFront();
await dash.locator(".tile").first().locator(".tileLink").click();
await dash.waitForTimeout(300);
check(
  "clicking a tile opens it",
  dashNav[0] === "https://github.com/",
  JSON.stringify(dashNav),
);

await dash.locator(".tile").first().locator(".tileRemove").click();
await dash.waitForTimeout(300);
check("removing a tile removes exactly one", (await dash.locator(".tile").count()) === 1);

await dash.reload({ waitUntil: "domcontentloaded" });
await dash.waitForTimeout(500);
check("favorites survive a reload", (await dash.locator(".tile").count()) === 1);

// Titles come from the user, but a tile is still a rendered string.
await dash.evaluate(() =>
  chrome.storage.local.set({
    favorites: [{ id: "https://example.com/", url: "https://example.com/", name: "<img src=x onerror=alert(1)>" }],
  }),
);
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.waitForTimeout(500);
check(
  "a tile name is text, never markup",
  (await dash.locator(".tileName").innerText()).includes("<img src=x") &&
    // The name renders as text nodes only. The tile does now carry one <img> of
    // its own — the favicon — so counting images across the whole tile would
    // stop testing what this is about.
    (await dash.locator(".tileName").evaluate((n) => n.children.length)) === 0,
);

// --- the + menu, attachments, and the placeholder --------------------------------

await dash.evaluate(() => chrome.storage.local.set({ mode: "chatgpt" }));
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.bringToFront();
await dash.waitForTimeout(400);

check(
  "the placeholder names the destination you chose",
  (await dash.locator("#query").getAttribute("placeholder")) === "Ask ChatGPT, or type a URL",
  await dash.locator("#query").getAttribute("placeholder"),
);
await dash.locator('.target[data-mode="claude"]').click();
await dash.waitForTimeout(200);
check(
  "...and follows when it changes",
  (await dash.locator("#query").getAttribute("placeholder")) === "Ask Claude, or type a URL",
  await dash.locator("#query").getAttribute("placeholder"),
);

// The + menu's items are menuitems; styling that only matched [role=option]
// left the whole menu unstyled, which is invisible to every other check.
await dash.locator("#plusButton").click();
await dash.waitForTimeout(200);
const menuItemLayout = await dash
  .locator("#plusMenu [role=menuitem]")
  .first()
  .evaluate((n) => getComputedStyle(n).display);
check("the + menu's items are laid out, not raw inline text", menuItemLayout === "grid", menuItemLayout);
await dash.keyboard.press("Escape");

// Attachments
const ATTACH = join(tmpdir(), "archer-attach.py");
writeFileSync(ATTACH, "def add(a, b):\n    return a + b\n");

await dash.setInputFiles("#attachInput", ATTACH);
await dash.waitForTimeout(400);
check("attaching a file adds a chip", (await dash.locator(".chip").count()) === 1);
check(
  "...and does not paste the file into the box, which would strip its newlines",
  (await dash.inputValue("#query")) === "",
);
check("...and arms send even with an empty box", await dash.locator("#send").isEnabled());

dashNav.length = 0;
await dash.fill("#query", "explain this");
await dash.locator("#query").press("Enter");
await dash.waitForTimeout(400);
const sent = decodeURIComponent((dashNav[0] ?? "").replace(/^[^?]*\?q=/, ""));
check(
  "the file rides with the prompt, newlines intact",
  sent.startsWith("explain this") && sent.includes("--- archer-attach.py ---") && sent.includes("\n    return a + b"),
  JSON.stringify(sent.slice(0, 120)),
);
check("...and the chip is cleared afterwards", (await dash.locator(".chip").count()) === 0);

await dash.fill("#query", "");
await dash.setInputFiles("#attachInput", ATTACH);
await dash.waitForTimeout(300);
check("...and re-arms it on the next attachment", await dash.locator("#send").isEnabled());
await dash.locator(".chipRemove").click();
await dash.waitForTimeout(250);
check("a chip can be removed", (await dash.locator(".chip").count()) === 0);
check("...which disarms send again", await dash.locator("#send").isDisabled());
rmSync(ATTACH, { force: true });

// --- favourite tiles show the site's own icon -------------------------------------
//
// `_favicon` reads Chrome's *local* icon store — no request reaches the site,
// which is the only reason this feature is allowed to exist here at all.
//
// It also never fails: for a site the browser has never seen it answers 200
// with a generic globe, byte-identical every time. So an onerror fallback can
// never fire, and a naive <img> would replace every monogram with the same grey
// planet. A fresh profile has visited nothing, so every tile below must still
// be showing its initials.

await dash.evaluate(() =>
  chrome.storage.local.set({
    favorites: [{ id: "https://github.com", url: "https://github.com", name: "GitHub" }],
  }),
);
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.bringToFront();
await dash.waitForTimeout(700);

check(
  "the favicon permission is what a tile reads, and it is granted here",
  await dash.evaluate(() => chrome.permissions.contains({ permissions: ["favicon"] })),
);
check(
  "a site Chrome has no icon for keeps its initials, not a generic globe",
  (await dash.locator(".tile .tileIcon").isHidden()) &&
    (await dash.locator(".tile .tileFace").innerText()).trim() === "GH",
  `hidden=${await dash.locator(".tile .tileIcon").isHidden()} face=${await dash.locator(".tile .tileFace").innerText()}`,
);

// The placeholder is byte-identical for every unknown site — the fact the whole
// fallback rests on. If Chrome ever stops doing this, the check above starts
// passing for the wrong reason, so assert it directly.
const placeholders = await dash.evaluate(async () => {
  const grab = async (u) => {
    const r = await fetch(chrome.runtime.getURL("/_favicon/?pageUrl=" + encodeURIComponent(u) + "&size=32"));
    return [...new Uint8Array(await r.arrayBuffer())].join(",");
  };
  return [await grab("https://never-seen-one.invalid/"), await grab("https://never-seen-two.invalid/")];
});
check(
  "_favicon answers with one identical placeholder for every unknown site",
  placeholders[0] === placeholders[1] && placeholders[0].length > 0,
  `${placeholders[0].length} vs ${placeholders[1].length}`,
);

await dash.evaluate(() => chrome.storage.local.set({ favorites: [] }));
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.bringToFront();
await dash.waitForTimeout(400);

// --- the default-engine hint only appears where it is true ------------------------
//
// It reads "Prompts go to your default search engine", which is a statement
// about Auto and Default-engine mode and a flat contradiction of the Google,
// ChatGPT, Claude and Perplexity pills.

await dash.evaluate(() => chrome.storage.local.set({ mode: "auto", engineNudgeDismissed: false }));
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.bringToFront();
await dash.waitForTimeout(400);
check("the default-engine hint shows in Auto", await dash.locator("#engineNudge").isVisible());

await dash.locator('.target[data-mode="google"]').click();
await dash.waitForTimeout(250);
check("...and goes away once a named destination is chosen", await dash.locator("#engineNudge").isHidden());

await dash.locator("#modeButton").click();
await dash.locator('#modeMenu [role=option][data-mode="search"]').click();
await dash.waitForTimeout(250);
check("...and comes back for Default engine, which does use one", await dash.locator("#engineNudge").isVisible());
await dash.evaluate(() => chrome.storage.local.set({ mode: "chatgpt", engineNudgeDismissed: true }));
await dash.reload({ waitUntil: "domcontentloaded" });
await dash.bringToFront();
await dash.waitForTimeout(400);

/**
 * A real .docx, built here rather than checked in: a zip whose word/document.xml
 * holds the paragraphs. Small enough to read, real enough that the extension's
 * own unzip has to work for the check to pass.
 */
function makeDocx(text) {
  const body =
    "<w:document><w:body>" +
    text
      .split("\n")
      .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
      .join("") +
    "</w:body></w:document>";

  const name = Buffer.from("word/document.xml");
  const raw = Buffer.from(body);
  const packed = deflateRawSync(raw);

  const local = Buffer.alloc(30 + name.length + packed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  packed.copy(local, 30 + name.length);

  const dir = Buffer.alloc(46 + name.length);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt32LE(packed.length, 20);
  dir.writeUInt32LE(raw.length, 24);
  dir.writeUInt16LE(name.length, 28);
  dir.writeUInt32LE(0, 42);
  name.copy(dir, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(local.length, 16);

  return Buffer.concat([local, dir, eocd]);
}

// --- attachments that are not text ------------------------------------------------
//
// The picker used to carry an `accept` list of text extensions, so the PDF or
// the spreadsheet someone came to attach was greyed out with no explanation.
// It now accepts anything and src/extract.js says what it could and could not
// read — which only means something if a chip actually reports the difference.

check(
  "the file picker does not grey out the file you came to attach",
  (await dash.locator("#attachInput").getAttribute("accept")) === null,
  await dash.locator("#attachInput").getAttribute("accept"),
);

const DOCX = join(tmpdir(), "archer-brief.docx");
writeFileSync(DOCX, Buffer.from(makeDocx("Quarterly review\nRevenue rose four percent.")));
await dash.setInputFiles("#attachInput", DOCX);
await dash.waitForTimeout(600);
check("a .docx attaches", (await dash.locator(".chip").count()) === 1);
check(
  "...and the chip says it is a Word file, not a byte count",
  (await dash.locator(".chipSize").innerText()).startsWith("Word"),
  await dash.locator(".chipSize").innerText(),
);

dashNav.length = 0;
await dash.fill("#query", "summarise this");
await dash.locator("#query").press("Enter");
await dash.waitForTimeout(500);
const docxSent = decodeURIComponent((dashNav[0] ?? "").replace(/^[^?]*\?q=/, ""));
check(
  "the words inside the .docx actually reach the destination",
  docxSent.includes("Quarterly review") && docxSent.includes("Revenue rose four percent"),
  JSON.stringify(docxSent.slice(0, 160)),
);
rmSync(DOCX, { force: true });

// A scan has no text layer, and saying so beats attaching nothing while the
// chip claims a PDF went.
const SCAN = join(tmpdir(), "archer-scan.pdf");
writeFileSync(SCAN, "%PDF-1.4\n1 0 obj\n<< /Filter /DCTDecode >>\nstream\nxx\nendstream\n%%EOF");
await dash.fill("#query", "");
await dash.setInputFiles("#attachInput", SCAN);
await dash.waitForTimeout(600);
check(
  "a PDF with no text layer is attached and labelled, not silently empty",
  (await dash.locator(".chipSize").innerText()).toLowerCase().includes("scan"),
  await dash.locator(".chipSize").innerText(),
);
await dash.locator(".chipRemove").click();
await dash.waitForTimeout(200);
rmSync(SCAN, { force: true });

// An image can only go on the Answer-here path, which posts a body. A hand-off
// puts the prompt in a URL, and a URL cannot carry a picture — so the page has
// to say that rather than dropping it between two screens.
const SHOT = join(tmpdir(), "archer-shot.png");
writeFileSync(SHOT, Buffer.from("89504e470d0a1a0a", "hex"));
await dash.setInputFiles("#attachInput", SHOT);
await dash.waitForTimeout(600);
check("an image attaches", (await dash.locator(".chip").count()) === 1);
check(
  "...and the page says an image needs Answer here",
  (await dash.locator("#attachStatus").innerText()).toLowerCase().includes("image"),
  await dash.locator("#attachStatus").innerText(),
);
await dash.locator(".chipRemove").click();
await dash.waitForTimeout(200);
rmSync(SHOT, { force: true });

// The destination select went blank the moment a mode existed that it had no
// <option> for — the stored value matched nothing, so it rendered empty and the
// page looked broken.
check(
  "every mode the menu offers is also in the settings dropdown",
  await dash.evaluate(async () => {
    const page = await fetch(chrome.runtime.getURL("options.html")).then((r) => r.text());
    const inOptions = new Set([...page.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]));
    return [...document.querySelectorAll("#modeMenu [role=option]")].every((li) =>
      inOptions.has(li.dataset.mode),
    );
  }),
);

// A rejection has to survive the repaint. paintAttachments() owns the status line
// and clears it when nothing is attached, so a message written while reading the
// files was wiped a moment later — and if every file was rejected, all the user
// saw was a picker that closed and did nothing.
const HUGE = join(tmpdir(), "archer-huge.bin");
writeFileSync(HUGE, Buffer.alloc(11 * 1024 * 1024));
await dash.setInputFiles("#attachInput", HUGE);
await dash.waitForTimeout(700);
check("nothing attaches when the only file is too big", (await dash.locator(".chip").count()) === 0);
check(
  "...and the page says why, rather than closing the picker onto silence",
  (await dash.locator("#attachStatus").innerText()).includes("10 MB"),
  await dash.locator("#attachStatus").innerText(),
);
rmSync(HUGE, { force: true });

// --- settings opens somewhere you can see -----------------------------------------
//
// chrome.runtime.openOptionsPage() takes a special path when the caller is the
// new tab page: it *replaces* that tab instead of opening one. Measured with a
// real click in a headed browser — two tabs before, two after, and the new tab
// had become options.html. Indistinguishable from the button doing nothing.

const beforeGear = dashCtx.pages().length;
await dash.locator("#openSettings").click();
await dash.waitForTimeout(900);
const openedByGear = dashCtx.pages().filter((p) => p.url().endsWith("/options.html"));
check(
  "the gear opens settings in a new tab",
  dashCtx.pages().length === beforeGear + 1,
  `${beforeGear} -> ${dashCtx.pages().length}`,
);
check("...and the new tab page survives it", dash.url().includes("newtab.html"), dash.url());
for (const p of openedByGear) await p.close();
await dash.bringToFront();
await dash.waitForTimeout(200);

const beforeMenu = dashCtx.pages().length;
await dash.locator("#plusButton").click();
await dash.waitForTimeout(200);
await dash.locator('#plusMenu [role=menuitem][data-action="settings"]').click();
await dash.waitForTimeout(900);
check(
  "the + menu's Settings item opens settings too",
  dashCtx.pages().length === beforeMenu + 1,
  `${beforeMenu} -> ${dashCtx.pages().length}`,
);
for (const p of dashCtx.pages().filter((p) => p.url().endsWith("/options.html"))) await p.close();
await dash.bringToFront();
await dash.waitForTimeout(200);

// --- navigation targets this tab, not whichever one is active --------------------
//
// chrome.tabs.update({url}) with no id navigates the *active* tab. Chrome
// pre-renders the new tab page, so a background new tab that submitted would
// have sent some other tab somewhere.
const bystander = await dashCtx.newPage();
await bystander.goto("about:blank");
await bystander.bringToFront();
await dash.waitForTimeout(200);

dashNav.length = 0;
await dash.evaluate(() => {
  document.getElementById("query").value = "example.com";
  document.getElementById("searchForm").requestSubmit();
});
await dash.waitForTimeout(500);
check(
  "a submit from a background tab navigates that tab, not the active one",
  bystander.url() === "about:blank" && dashNav.some((u) => u.startsWith("https://example.com")),
  JSON.stringify({ bystander: bystander.url(), dashNav }),
);
await bystander.close();
await dash.bringToFront();

await dashCtx.close();
rmSync(dashFixture, { recursive: true, force: true });

// --- Phase 7: the permissions panel -------------------------------------------------
//
// The listing's central claim is "off until you turn it on". That is only true
// if the manifest says so and the panel tells the truth about it, so both are
// asserted here rather than taken on trust.

const shipCtx = await chromium.launchPersistentContext("", {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
});
const shipOptions = await shipCtx.newPage();
await shipOptions.goto(`chrome-extension://${extensionId(EXT)}/options.html`, {
  waitUntil: "domcontentloaded",
});
await shipOptions.waitForTimeout(500);

const shipManifest = await shipOptions.evaluate(() => chrome.runtime.getManifest());
check(
  "the install prompt is still just search + storage, after seven phases",
  JSON.stringify([...shipManifest.permissions].sort()) === JSON.stringify(["search", "storage"]),
  JSON.stringify(shipManifest.permissions),
);
check("no host permission is required at install", !shipManifest.host_permissions?.length);

// Every one of these switches worked all along — verified with a real click in
// a headed browser. What did not work was Chrome's answer coming back: its
// popup opens at the *top* of the window, some way from a panel at the bottom
// of a long page, with Deny focused by default. Miss it and the row re-rendered
// byte-identical. Saying so up front is the fix.
check(
  "the permissions panel warns that Chrome asks in a popup elsewhere on screen",
  await shipOptions.locator(".heads-up").first().isVisible(),
);
const headsUp = (await shipOptions.locator(".heads-up").first().innerText()).toLowerCase();
check(
  "...and says where it opens and what its default is",
  headsUp.includes("top of the window") && headsUp.includes("deny"),
  headsUp,
);

// --- the settings page is navigable --------------------------------------------
//
// It was nine cards in one undifferentiated scroll, which is why the Permissions
// panel — the answer to most "why isn't this working" — was the part nobody
// reached.

const navTargets = await shipOptions.locator(".navLink").evaluateAll((els) =>
  els.map((e) => e.getAttribute("href")),
);
check("every section has a nav link", navTargets.length >= 7, JSON.stringify(navTargets));
check(
  "every nav link points at a section that exists",
  await shipOptions.evaluate(
    (hrefs) => hrefs.every((h) => document.querySelector(h) !== null),
    navTargets,
  ),
  JSON.stringify(navTargets),
);

// A link to a card that is hidden until a key is set scrolls to nothing.
check(
  "the Model and Budget links are hidden while their cards are",
  (await shipOptions.locator("#navModel").isHidden()) &&
    (await shipOptions.locator("#modelCard").isHidden()) &&
    (await shipOptions.locator("#navBudget").isHidden()) &&
    (await shipOptions.locator("#budgetCard").isHidden()),
  `model ${await shipOptions.locator("#modelCard").isHidden()}/${await shipOptions.locator("#navModel").isHidden()}, ` +
    `budget ${await shipOptions.locator("#budgetCard").isHidden()}/${await shipOptions.locator("#navBudget").isHidden()}`,
);

// Each card says its own state, so "is the weather on?" is answerable without
// scrolling to the weather form and reading it.
check(
  "a section's state is readable from its header",
  (await shipOptions.locator("#stateDestination").innerText()).trim().length > 0 &&
    (await shipOptions.locator("#stateWeather").innerText()).trim() === "Off" &&
    (await shipOptions.locator("#stateAnswers").innerText()).trim() === "No key set",
  [
    await shipOptions.locator("#stateDestination").innerText(),
    await shipOptions.locator("#stateWeather").innerText(),
    await shipOptions.locator("#stateAnswers").innerText(),
  ].join(" | "),
);
check(
  "...including how many permissions are on",
  (await shipOptions.locator("#statePermissions").innerText()).trim() === "0 of 7 on",
  await shipOptions.locator("#statePermissions").innerText(),
);

// The long justifications are folded away, not deleted — this page's
// explanations are half the product.
const whys = await shipOptions.locator(".why").count();
check("the dense explanations are behind disclosures", whys >= 4, String(whys));
check(
  "...and every one of them opens",
  await shipOptions.evaluate(() =>
    [...document.querySelectorAll(".why")].every((d) => d.querySelector("summary") && d.textContent.trim()),
  ),
);

// Clicking one is what a reader does first, so it must actually reveal text.
const firstWhy = shipOptions.locator(".why").first();
check("a disclosure starts closed", !(await firstWhy.evaluate((d) => d.open)));
await firstWhy.locator("summary").click();
await shipOptions.waitForTimeout(150);
check("...and opens on click", await firstWhy.evaluate((d) => d.open));
check("...revealing its explanation", await firstWhy.locator(".hint").isVisible());

// The highlight follows the page. It is an IntersectionObserver rather than a
// scroll listener, and it may only ever *add* highlighting — if it never
// reports, every link stays plain and every link still works.
await shipOptions.setViewportSize({ width: 1240, height: 900 });
await shipOptions.locator("#permissions").scrollIntoViewIfNeeded();
await shipOptions.waitForTimeout(500);
check(
  "the nav follows which section you are looking at",
  await shipOptions.evaluate(
    () => document.querySelector(".navLink.isHere")?.getAttribute("href") === "#permissions",
  ),
  await shipOptions.evaluate(() => document.querySelector(".navLink.isHere")?.getAttribute("href") ?? "none"),
);

await shipOptions.locator("#destination").scrollIntoViewIfNeeded();
await shipOptions.waitForTimeout(500);
check(
  "...and moves back",
  await shipOptions.evaluate(
    () => document.querySelector(".navLink.isHere")?.getAttribute("href") === "#destination",
  ),
  await shipOptions.evaluate(() => document.querySelector(".navLink.isHere")?.getAttribute("href") ?? "none"),
);

// At most one, or the highlight is telling you two places at once.
check(
  "exactly one link is lit at a time",
  (await shipOptions.locator(".navLink.isHere").count()) === 1,
  String(await shipOptions.locator(".navLink.isHere").count()),
);

check(
  "the weather card says a popup is coming before you press the button",
  await shipOptions.locator("#weatherAccessHint").isVisible(),
);
check(
  "...and the button names what it is about to do",
  (await shipOptions.locator("#savePlace").innerText()).trim() === "Allow & save place",
  await shipOptions.locator("#savePlace").innerText(),
);

const listed = await shipOptions.locator(".grant").evaluateAll((els) => els.map((e) => e.dataset.grant));
check(
  "every optional permission is listed in the panel",
  listed.length === 7,
  JSON.stringify(listed),
);

// Nothing is granted in a fresh profile, so the panel must say so for all of them.
check(
  "all of them read Off before anything is enabled",
  (await shipOptions.locator(".grant .grantState").allInnerTexts()).every((t) => t.trim() === "OFF"),
  JSON.stringify(await shipOptions.locator(".grant .grantState").allInnerTexts()),
);
check(
  "...and each offers to turn it on",
  (await shipOptions.locator(".grantToggle").allInnerTexts()).every((t) => t.trim() === "Turn on"),
);

// Every optional permission and origin in the manifest has to appear somewhere in
// the panel, or the listing's claim is unverifiable for whatever was left out.
const declared = [
  ...(shipManifest.optional_permissions ?? []),
  ...(shipManifest.optional_host_permissions ?? []),
].sort();
const covered = await shipOptions.evaluate(() =>
  [...document.querySelectorAll(".grant")].map((e) => e.dataset.grant),
);
const { GRANTS } = await import("../extension/src/permissions.js");
const explained = GRANTS.flatMap((g) => [...(g.permissions ?? []), ...(g.origins ?? [])]).sort();
check(
  "the panel accounts for every optional permission the manifest declares",
  JSON.stringify(declared) === JSON.stringify(explained),
  JSON.stringify({ declared, explained }),
);
check("...and every listed grant is rendered", covered.length === GRANTS.length);

check(
  "the heavier grant says why it is heavier",
  (await shipOptions.locator('.grant[data-grant="closedTabs"] .grantCost').innerText()).includes(
    "browsing history",
  ),
);
check(
  "every grant explains itself in a sentence, not a permission name",
  (await shipOptions.locator(".grantWhy").allInnerTexts()).every((t) => t.trim().length > 40),
);

await shipCtx.close();

// --- dark mode ---------------------------------------------------------------
// A second context, because colorScheme is fixed when the context is created.
// Dark is where a missing token hides: the page still renders, just wrongly.

const darkCtx = await chromium.launchPersistentContext("", {
  headless: true,
  channel: "chromium",
  colorScheme: "dark",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox"],
});
const darkPage = await darkCtx.newPage();
await darkPage.goto(NEWTAB, { waitUntil: "domcontentloaded" });
await darkPage.waitForTimeout(200);

const darkBg = await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
check("dark: the ink ground is applied", darkBg === "rgb(20, 20, 22)", darkBg);

contrast = await darkPage.evaluate(contrastProbe);
check(
  "dark: row descriptions meet AA against the page",
  contrast.description >= 4.5,
  `${contrast.description.toFixed(2)}:1`,
);
check("dark: row titles meet AA against the page", contrast.title >= 4.5, `${contrast.title.toFixed(2)}:1`);

await darkCtx.close();

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
