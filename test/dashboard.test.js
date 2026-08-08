import { test } from "node:test";
import assert from "node:assert/strict";
import { greetingFor, describeMoment, msToNextMinute } from "../extension/src/clock.js";
import { describeCode, parseForecast, isStale, unitSymbol, CACHE_MS } from "../extension/src/weather.js";
import {
  normaliseURL,
  hostOf,
  nameFor,
  monogram,
  hueFor,
  addFavorite,
  removeFavorite,
  faviconURL,
  NO_SUCH_SITE,
} from "../extension/src/favorites.js";

// --- the clock ---------------------------------------------------------------

const at = (hour, minute = 0, second = 0) => new Date(2026, 1, 24, hour, minute, second);

test("greetings cover the whole day, including the small hours", () => {
  assert.equal(greetingFor(at(6)), "Good morning");
  assert.equal(greetingFor(at(11, 59)), "Good morning");
  assert.equal(greetingFor(at(12)), "Good afternoon");
  assert.equal(greetingFor(at(16, 59)), "Good afternoon");
  assert.equal(greetingFor(at(17)), "Good evening");
  assert.equal(greetingFor(at(21, 59)), "Good evening");
  assert.equal(greetingFor(at(22)), "Good night");
  // The band that a simple morning/afternoon/evening split gets wrong.
  assert.equal(greetingFor(at(1)), "Good night");
  assert.equal(greetingFor(at(4, 59)), "Good night");
});

test("the moment carries a time, a greeting and a date", () => {
  const moment = describeMoment(at(22, 55), { locale: "en-US", timeZone: "Asia/Calcutta", hour12: true });
  assert.equal(moment.time, "10:55 PM");
  assert.equal(moment.greeting, "Good night");
  assert.match(moment.date, /^Tuesday, February 24 · Asia\/Calcutta$/);
});

test("a 24-hour locale is respected rather than overridden", () => {
  assert.equal(describeMoment(at(22, 55), { locale: "en-GB", hour12: false }).time, "22:55");
});

test("underscores in a zone name are spaces to a reader", () => {
  assert.match(describeMoment(at(9), { locale: "en-US", timeZone: "America/New_York" }).date, /New York$/);
});

test("no zone still produces a usable date line", () => {
  assert.equal(describeMoment(at(9), { locale: "en-US", timeZone: "" }).date, "Tuesday, February 24");
});

test("the tick aligns to the next minute rather than drifting", () => {
  assert.equal(msToNextMinute(at(10, 30, 0)), 60_000);
  assert.equal(msToNextMinute(at(10, 30, 59)), 1000);
  assert.ok(msToNextMinute(new Date()) > 0);
});

// --- weather -----------------------------------------------------------------

test("WMO codes collapse to states worth naming", () => {
  assert.equal(describeCode(0).text, "Clear");
  assert.equal(describeCode(2).text, "Partly cloudy");
  assert.equal(describeCode(3).text, "Overcast");
  assert.equal(describeCode(45).text, "Fog");
  assert.equal(describeCode(65).text, "Rain");
  assert.equal(describeCode(75).text, "Snow");
  assert.equal(describeCode(95).text, "Thunderstorm");
});

test("an unknown code degrades rather than throwing", () => {
  assert.equal(describeCode(999).text, "—");
  assert.equal(describeCode(undefined).icon, "cloud");
});

test("units are named, not converted — Open-Meteo returns what we ask for", () => {
  assert.equal(unitSymbol("celsius"), "°C");
  assert.equal(unitSymbol("fahrenheit"), "°F");
  assert.equal(unitSymbol(undefined), "°C");
});

const PAYLOAD = {
  current: { temperature_2m: 21.6, weather_code: 2 },
  daily: { temperature_2m_max: [28.9], temperature_2m_min: [19.5] },
};

test("a forecast becomes the four numbers the card shows", () => {
  const reading = parseForecast(PAYLOAD, "Brighton, England, GB", "celsius");
  assert.equal(reading.temperature, 22);
  assert.equal(reading.text, "Partly cloudy");
  assert.equal(reading.high, 29);
  assert.equal(reading.low, 20);
  assert.equal(reading.place, "Brighton, England, GB");
});

test("a forecast with no temperature is an error, not a blank card", () => {
  assert.throws(() => parseForecast({ current: {} }, "x", "celsius"), /without a temperature/);
});

test("a missing daily range is null rather than NaN", () => {
  const reading = parseForecast({ current: { temperature_2m: 10, weather_code: 0 } }, "x", "celsius");
  assert.equal(reading.high, null);
  assert.equal(reading.low, null);
});

test("readings go stale on a schedule", () => {
  const now = 1_700_000_000_000;
  assert.equal(isStale({ at: now }, now), false);
  assert.equal(isStale({ at: now - CACHE_MS + 1000 }, now), false);
  assert.equal(isStale({ at: now - CACHE_MS - 1 }, now), true);
  assert.equal(isStale(null, now), true);
  assert.equal(isStale({}, now), true);
});

// --- favorites ---------------------------------------------------------------

test("a bare host becomes an https address", () => {
  assert.equal(normaliseURL("example.com"), "https://example.com/");
  assert.equal(normaliseURL("  example.com/path  "), "https://example.com/path");
});

test("an explicit http address is kept as-is", () => {
  assert.equal(normaliseURL("http://localhost:3000"), "http://localhost:3000/");
});

test("a favorite can only ever be http(s)", () => {
  // A tile is a link the user clicks, so this is the same rule the search box
  // enforces, for the same reason: this page is a privileged extension origin.
  for (const hostile of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "chrome://settings",
    "  ",
    "",
    null,
  ]) {
    assert.equal(normaliseURL(hostile), null, String(hostile));
  }
});

test("userinfo in the authority is refused, as it is in the search box", () => {
  assert.equal(normaliseURL("https://google.com@evil.com"), null);
});

test("a name is derived from the site when none is given", () => {
  assert.equal(nameFor("https://github.com/"), "Github");
  assert.equal(nameFor("https://news.ycombinator.com/"), "Ycombinator");
  assert.equal(nameFor("https://www.bbc.co.uk/"), "Bbc", "a multi-part suffix is not the name");
  assert.equal(nameFor("https://www.google.co.jp/"), "Google");
  assert.equal(nameFor("https://mail.google.com/"), "Google");
  assert.equal(nameFor("https://github.com/", "  GitHub  "), "GitHub");
});

test("hosts drop the www", () => {
  assert.equal(hostOf("https://www.github.com/x"), "github.com");
  assert.equal(hostOf("not a url"), "");
});

test("monograms read as the site they came from", () => {
  assert.equal(monogram("GitHub"), "GH");
  assert.equal(monogram("YouTube"), "YT");
  assert.equal(monogram("LinkedIn"), "LI");
  assert.equal(monogram("Google Drive"), "GD");
  assert.equal(monogram("gmail"), "GM");
  assert.equal(monogram("X"), "X");
  assert.equal(monogram(""), "?");
});

test("a hue is stable for a host and spread across the wheel", () => {
  assert.equal(hueFor("github.com"), hueFor("github.com"));
  assert.notEqual(hueFor("github.com"), hueFor("youtube.com"));
  for (const seed of ["a", "github.com", "", "🙂"]) {
    const hue = hueFor(seed);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${seed} → ${hue}`);
  }
});

test("adding normalises and names in one step", () => {
  const result = addFavorite([], { url: "github.com" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.favorites[0], {
    id: "https://github.com/",
    url: "https://github.com/",
    name: "Github",
  });
});

test("a duplicate is refused with a reason", () => {
  const first = addFavorite([], { url: "github.com" });
  const second = addFavorite(first.favorites, { url: "https://github.com" });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already/);
});

test("junk is refused with a reason rather than stored", () => {
  const result = addFavorite([], { url: "javascript:alert(1)" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /web address/);
});

test("removing takes the one asked for and nothing else", () => {
  const list = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(removeFavorite(list, "a"), [{ id: "b" }]);
  assert.deepEqual(removeFavorite(list, "nope"), list);
  assert.deepEqual(removeFavorite(null, "a"), []);
});

// --- what a row may link to --------------------------------------------------

const { isWebLink } = await import("../extension/src/browsing.js");

test("only http(s) can become a top-site or closed-tab row", () => {
  assert.equal(isWebLink("https://example.com/"), true);
  assert.equal(isWebLink("http://localhost:3000/"), true);
  for (const bad of ["chrome://newtab", "file:///etc/passwd", "javascript:alert(1)", "", null]) {
    assert.equal(isWebLink(bad), false, String(bad));
  }
});

test("the Web Store is excluded — an extension cannot navigate there", () => {
  // Chrome's only default top site in a fresh profile, and clicking it killed
  // the renderer.
  assert.equal(isWebLink("https://chrome.google.com/webstore?hl=en"), false);
  assert.equal(isWebLink("https://chromewebstore.google.com/detail/x"), false);
});

// --- favicons ---------------------------------------------------------------------
//
// The URL is built here rather than in dashboard.js so it can be checked without
// a browser. `_favicon` is Chrome's *local* icon store: reading it makes no
// request to the site, which is the only reason favourites show real icons at
// all — fetching https://site/favicon.ico per tile would announce every
// favourite to its operator on every new tab.

test("faviconURL points at Chrome's own icon store, not the site", () => {
  const url = faviconURL("https://github.com/", { base: "chrome-extension://abc/" });
  assert.ok(url.startsWith("chrome-extension://abc/_favicon/"), url);
  assert.ok(!url.includes("github.com/favicon"), url);
});

test("faviconURL encodes the page address as a parameter", () => {
  const url = faviconURL("https://example.com/a?b=c&d=e", { base: "chrome-extension://abc" });
  assert.ok(url.includes("pageUrl=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc%26d%3De"), url);
  // The site's own query must not leak into the favicon request's parameters.
  assert.equal(url.split("&").length, 2, url);
});

test("faviconURL takes a size, and defaults to one", () => {
  assert.ok(faviconURL("https://a.test/", { base: "chrome-extension://abc" }).endsWith("size=32"));
  assert.ok(faviconURL("https://a.test/", { base: "chrome-extension://abc", size: 64 }).endsWith("size=64"));
});

test("faviconURL tolerates a base with or without its trailing slash", () => {
  const withSlash = faviconURL("https://a.test/", { base: "chrome-extension://abc/" });
  const without = faviconURL("https://a.test/", { base: "chrome-extension://abc" });
  assert.equal(withSlash, without);
  assert.ok(!withSlash.includes("//_favicon"), withSlash);
});

test("faviconURL is empty rather than wrong without a base or a page", () => {
  assert.equal(faviconURL("https://a.test/", {}), "");
  assert.equal(faviconURL("", { base: "chrome-extension://abc" }), "");
});

test("the placeholder probe asks about an address that cannot resolve", () => {
  // _favicon answers 200 with a generic globe for anything it has never seen,
  // so the only way to recognise that globe is to ask for a copy of it. The
  // address has to be one no real favourite could ever be.
  assert.match(NO_SUCH_SITE, /^https:\/\//);
  assert.ok(NO_SUCH_SITE.endsWith(".invalid/"), NO_SUCH_SITE);
});
