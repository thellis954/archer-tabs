// Wires the clock, the weather card and the favourites bar into the page.
//
// Split out of newtab.js because that file is meant to be the router's wiring,
// not everything the page can show. Nothing here decides anything — the
// decisions live in clock.js, weather.js and favourites.js, which are pure.
//
// Every string painted here comes from a place name the user typed, a site
// name, or a forecast service. All of it goes in with textContent.

import { describeMoment, msToNextMinute } from "./clock.js";
import { fetchWeather, isStale, unitSymbol, WEATHER_ORIGINS } from "./weather.js";
import { hostOf, hueFor, monogram, addFavourite, removeFavourite } from "./favourites.js";
import {
  readFavourites,
  saveFavourites,
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

// --- favourites ------------------------------------------------------------------

export async function renderFavourites({ onNavigate }) {
  const list = $("tiles");
  const favourites = await readFavourites();

  list.replaceChildren();
  $("favouritesEmpty").hidden = favourites.length > 0;

  const template = document.getElementById("tileTemplate");

  for (const favourite of favourites) {
    const node = template.content.firstElementChild.cloneNode(true);

    const link = node.querySelector(".tileLink");
    link.href = favourite.url; // normaliseURL guaranteed http(s) before this was stored
    link.title = favourite.url;

    const face = node.querySelector(".tileFace");
    face.textContent = monogram(favourite.name);
    // A stable hue per host, so a tile keeps its colour between sessions.
    face.style.setProperty("--tileHue", String(hueFor(hostOf(favourite.url) || favourite.url)));

    node.querySelector(".tileName").textContent = favourite.name;

    link.addEventListener("click", (event) => {
      event.preventDefault();
      onNavigate(favourite.url);
    });

    const remove = node.querySelector(".tileRemove");
    remove.setAttribute("aria-label", `Remove ${favourite.name}`);
    remove.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await saveFavourites(removeFavourite(await readFavourites(), favourite.id));
      await renderFavourites({ onNavigate });
    });

    list.append(node);
  }
}

export function wireFavouriteForm({ onNavigate }) {
  const form = $("addTileForm");
  const url = $("tileUrl");
  const status = $("tileStatus");

  const show = (open) => {
    form.hidden = !open;
    status.textContent = "";
    if (open) url.focus();
  };

  $("addFavourite").addEventListener("click", () => show(form.hidden));
  $("cancelTile").addEventListener("click", () => show(false));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const result = addFavourite(await readFavourites(), {
      url: url.value,
      name: $("tileName").value,
    });

    if (!result.ok) {
      status.textContent = result.reason;
      return;
    }

    await saveFavourites(result.favourites);
    url.value = "";
    $("tileName").value = "";
    show(false);
    await renderFavourites({ onNavigate });
  });
}
