// Wires the clock, the weather card and the favorites bar into the page.
//
// Split out of newtab.js because that file is meant to be the router's wiring,
// not everything the page can show. Nothing here decides anything — the
// decisions live in clock.js, weather.js and favorites.js, which are pure.
//
// Every string painted here comes from a place name the user typed, a site
// name, or a forecast service. All of it goes in with textContent.

import { describeMoment, msToNextMinute } from "./clock.js";
import { fetchWeather, isStale, unitSymbol, WEATHER_ORIGINS } from "./weather.js";
import { hostOf, hueFor, monogram, faviconURL, NO_SUCH_SITE, addFavorite, removeFavorite } from "./favorites.js";
import {
  readFavorites,
  saveFavorites,
  readWeatherSettings,
  readWeatherCache,
  saveWeatherCache,
} from "./settings.js";

const $ = (id) => document.getElementById(id);

// --- clock ---------------------------------------------------------------------

export function startClock() {
  const time = $("clockTime");
  const greeting = $("clockGreeting");
  const date = $("clockDate");

  const tick = () => {
    const moment = describeMoment(new Date());
    time.textContent = moment.time;
    greeting.textContent = moment.greeting;
    date.textContent = moment.date;

    // Re-aligned each time rather than set on an interval: a machine that
    // sleeps wakes with the clock still on the minute boundary.
    setTimeout(tick, msToNextMinute() + 50);
  };

  tick();
}

// --- weather -------------------------------------------------------------------

/** Weather icons live in the page as SVG; this picks one and clones it. */
function weatherGlyph(icon) {
  const source = document.getElementById(`weather-${icon}`) ?? document.getElementById("weather-cloud");
  return source ? source.content.firstElementChild.cloneNode(true) : null;
}

export async function refreshWeather() {
  const card = $("weather");
  const { place, unit } = await readWeatherSettings();

  if (!place) {
    card.hidden = true; // an empty weather card is worse than no weather card
    return;
  }

  let reading = await readWeatherCache();
  const matches = reading && reading.place === place.name && reading.unit === unit;

  if (!matches || isStale(reading)) {
    try {
      if (!(await hasWeatherAccess())) {
        // Permission was revoked in chrome://extensions after being granted.
        // Fall through to whatever was cached rather than blanking the card.
        if (!reading) return void (card.hidden = true);
      } else {
        reading = await fetchWeather({ ...place, unit });
        await saveWeatherCache(reading);
      }
    } catch {
      // Offline, or the service is down. A stale reading beats an error message
      // on a page whose job is to get out of the way.
      if (!reading) return void (card.hidden = true);
    }
  }

  paintWeather(reading);
}

function paintWeather(reading) {
  const card = $("weather");
  if (!reading) return void (card.hidden = true);

  const symbol = unitSymbol(reading.unit);
  $("weatherTemp").textContent = `${reading.temperature}${symbol}`;
  $("weatherText").textContent = reading.text;
  $("weatherPlace").textContent = reading.place;
  $("weatherRange").textContent =
    reading.high === null || reading.low === null ? "" : `H:${reading.high}° L:${reading.low}°`;

  const slot = $("weatherIcon");
  slot.replaceChildren();
  const glyph = weatherGlyph(reading.icon);
  if (glyph) slot.append(glyph);

  card.setAttribute(
    "aria-label",
    `${reading.temperature}${symbol}, ${reading.text}, ${reading.place}. Open settings to change.`,
  );
  card.hidden = false;
}

export async function hasWeatherAccess() {
  if (!globalThis.chrome?.permissions?.contains) return true; // plain-file dev
  try {
    return await chrome.permissions.contains({ origins: WEATHER_ORIGINS });
  } catch {
    return false;
  }
}

// --- favorites ------------------------------------------------------------------

export async function renderFavorites({ onNavigate }) {
  const list = $("tiles");
  const favorites = await readFavorites();

  list.replaceChildren();
  $("favoritesEmpty").hidden = favorites.length > 0;

  const template = document.getElementById("tileTemplate");

  for (const favorite of favorites) {
    const node = template.content.firstElementChild.cloneNode(true);

    const link = node.querySelector(".tileLink");
    link.href = favorite.url; // normaliseURL guaranteed http(s) before this was stored
    link.title = favorite.url;

    const face = node.querySelector(".tileFace");
    const icon = face.querySelector(".tileIcon");
    // The monogram is written as a text node beside the <img>, not with
    // textContent, which would delete the image element.
    face.prepend(document.createTextNode(monogram(favorite.name)));
    paintIcon(icon, favorite.url);
    // A stable hue per host, so a tile keeps its colour between sessions.
    face.style.setProperty("--tileHue", String(hueFor(hostOf(favorite.url) || favorite.url)));

    node.querySelector(".tileName").textContent = favorite.name;

    link.addEventListener("click", (event) => {
      event.preventDefault();
      onNavigate(favorite.url);
    });

    const remove = node.querySelector(".tileRemove");
    remove.setAttribute("aria-label", `Remove ${favorite.name}`);
    remove.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await saveFavorites(removeFavorite(await readFavorites(), favorite.id));
      await renderFavorites({ onNavigate });
    });

    list.append(node);
  }
}

export function wireFavoriteForm({ onNavigate }) {
  const form = $("addTileForm");
  const url = $("tileUrl");
  const status = $("tileStatus");

  const show = (open) => {
    form.hidden = !open;
    status.textContent = "";
    if (open) url.focus();
  };

  $("addFavorite").addEventListener("click", () => show(form.hidden));
  $("cancelTile").addEventListener("click", () => show(false));

  /**
   * Chrome's icon store, asked for once.
   *
   * `contains` first so a second favourite does not re-open the popup, and the
   * result is never checked: a no just means initials, which is not a failure
   * worth a message.
   */
  async function askForIcons() {
    if (!globalThis.chrome?.permissions?.request) return false;
    try {
      if (await chrome.permissions.contains({ permissions: ["favicon"] })) return false;
      return await chrome.permissions.request({ permissions: ["favicon"] });
    } catch {
      /* declined, or unavailable. The monogram stands. */
      return false;
    }
  }

  /** Only while the icons are not already on, so it stops being said once true. */
  async function paintIconHint() {
    const hint = $("iconHint");
    if (!hint) return;
    hint.hidden = !globalThis.chrome?.permissions?.contains
      || (await chrome.permissions.contains({ permissions: ["favicon"] }).catch(() => true));
  }

  paintIconHint();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const result = addFavorite(await readFavorites(), {
      url: url.value,
      name: $("tileName").value,
    });

    if (!result.ok) {
      status.textContent = result.reason;
      return;
    }

    await saveFavorites(result.favorites);
    url.value = "";
    $("tileName").value = "";
    show(false);
    await renderFavorites({ onNavigate });

    // After the favourite is saved and painted, and deliberately not awaited.
    // Chrome's consent popup blocks until it is answered — asking first would
    // mean an unanswered dialog could stop a favourite being added at all, and
    // the icon is a decoration on a tile that already works.
    askForIcons().then((granted) => {
      if (!granted) return;
      // The hint is read once at load, so without this it keeps offering
      // something that has already happened until the page is reloaded.
      paintIconHint();
      renderFavorites({ onNavigate });
    });
  });
}

// --- favourite icons ------------------------------------------------------------------

/**
 * Chrome's "no icon for this site" placeholder, as bytes, fetched once.
 *
 * `_favicon` never fails: ask it about a site the browser has never seen and it
 * answers 200 with a generic globe — byte-identical every time, measured. So
 * there is no error to catch and no size to test; the only way to know an icon
 * is real is to know what the placeholder looks like and compare against it.
 * Asking about an address that cannot resolve is how we get a copy.
 *
 * `null` once we know we cannot tell, in which case every tile keeps its
 * monogram — the safe way to be wrong.
 */
let placeholderBytes;

async function iconBytes(pageUrl) {
  const base = globalThis.chrome?.runtime?.getURL?.("/");
  if (!base) return null;
  try {
    const response = await fetch(faviconURL(pageUrl, { base }));
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    // Without the `favicon` permission the request is blocked outright, which
    // is not an error worth reporting — it is the un-upgraded resting state.
    return null;
  }
}

const sameBytes = (a, b) => a && b && a.length === b.length && a.every((byte, at) => byte === b[at]);

/**
 * Shows the site's own icon, or leaves the monogram alone.
 *
 * Fails toward the monogram in every direction: no permission, no cached icon,
 * a placeholder, a fetch that throws. A wall of identical grey globes would be
 * worse than the letters it replaced.
 */
async function paintIcon(img, pageUrl) {
  const bytes = await iconBytes(pageUrl);
  if (!bytes) return;

  if (placeholderBytes === undefined) placeholderBytes = await iconBytes(NO_SUCH_SITE);
  if (placeholderBytes && sameBytes(bytes, placeholderBytes)) return;

  // Painted from the bytes already in hand rather than fetched a second time,
  // so what was checked is exactly what is shown.
  const url = URL.createObjectURL(new Blob([bytes]));
  img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
  img.addEventListener(
    "error",
    () => {
      URL.revokeObjectURL(url);
      img.hidden = true;
    },
    { once: true },
  );
  img.src = url;
  img.hidden = false;
}
