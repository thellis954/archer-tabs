// End-to-end checks against a real Chromium with the unpacked extension loaded.
//
// Not part of `npm test` — it needs a browser, so CI (which installs nothing)
// runs unit tests only. Run locally with: npm run e2e
//
// Requires playwright on the module path:
//   mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright

import { createHash } from "node:crypto";
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
check(
  "the selected option is focused on open",
  await page.evaluate(() => document.activeElement?.dataset.mode) === "auto",
);

await page.keyboard.press("ArrowDown");
check(
  "ArrowDown walks the options",
  await page.evaluate(() => document.activeElement?.dataset.mode) === "chatgpt",
);

await page.keyboard.press("ArrowUp");
await page.keyboard.press("ArrowUp");
// Against the last option as rendered, so adding a mode does not break this.
const lastMode = await page.locator("#modeMenu [role=option]").last().getAttribute("data-mode");
check(
  "ArrowUp wraps to the last option",
  (await page.evaluate(() => document.activeElement?.dataset.mode)) === lastMode,
  lastMode,
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
// A conversation Chrome only ever saw before it was named must not become a row.
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
check(
  "an untitled conversation is not offered as a row",
  !convoTitles.some((t) => t.toLowerCase() === "chatgpt"),
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
  CONVOS.every((c) => paired[c.title] === `— ${c.prompt}`),
  JSON.stringify(paired),
);
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
await power.fill("#query", "x");
await power.locator("#query").press("Alt+ArrowDown");
await power.waitForTimeout(150);
check(
  "Alt+ArrowDown cycles to the next target",
  (await power.locator("#modeLabel").innerText()).trim() === "ChatGPT",
  await power.locator("#modeLabel").innerText(),
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
  (await power.locator("#plusMenu [role=menuitem]").count()) === 5 &&
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
check("top sites join the rows once enabled", kinds.includes("site"), JSON.stringify(kinds));
check("recently closed tabs join them too", kinds.includes("closed"), JSON.stringify(kinds));
check(
  "a prompt still outranks both",
  kinds.indexOf("prompt") === 0,
  JSON.stringify(kinds),
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
