// Weather, from Open-Meteo.
//
// Chosen because it needs no account and no API key: there is nothing to store,
// nothing to leak, and no signup wall between a user and a working new tab.
// https://open-meteo.com — free for non-commercial use, no attribution required.
//
// **The location is a place name the user types, not the browser's geolocation.**
// That keeps `geolocation` out of the permission list entirely, and it lets the
// user choose how precise they are willing to be. A city name is sent to
// Open-Meteo to resolve; nothing else about the user is.
//
// The parsing and the code table are pure so they can be tested without a
// network; the two fetches are the only impure part.

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";

/** The host permissions this needs. Optional, requested when a place is saved. */
export const WEATHER_ORIGINS = ["https://api.open-meteo.com/*", "https://geocoding-api.open-meteo.com/*"];

/** Weather is not news. Half an hour keeps it honest without hammering anyone. */
export const CACHE_MS = 30 * 60_000;

/**
 * WMO 4677 weather codes, collapsed to the handful of states worth naming on a
 * new tab. The full table distinguishes "light" from "moderate" drizzle; nobody
 * reading a new tab page needs that.
 */
const CODES = [
  { codes: [0], text: "Clear", icon: "clear" },
  { codes: [1], text: "Mainly clear", icon: "clear" },
  { codes: [2], text: "Partly cloudy", icon: "partly" },
  { codes: [3], text: "Overcast", icon: "cloud" },
  { codes: [45, 48], text: "Fog", icon: "fog" },
  { codes: [51, 53, 55, 56, 57], text: "Drizzle", icon: "rain" },
  { codes: [61, 63, 65, 66, 67, 80, 81, 82], text: "Rain", icon: "rain" },
  { codes: [71, 73, 75, 77, 85, 86], text: "Snow", icon: "snow" },
  { codes: [95, 96, 99], text: "Thunderstorm", icon: "storm" },
];

/** @returns {{text: string, icon: string}} */
export function describeCode(code) {
  return CODES.find((entry) => entry.codes.includes(Number(code))) ?? { text: "—", icon: "cloud" };
}

/** Open-Meteo speaks Celsius or Fahrenheit natively, so nothing is converted here. */
export const UNITS = ["celsius", "fahrenheit"];
export const unitSymbol = (unit) => (unit === "fahrenheit" ? "°F" : "°C");

/**
 * Turns an Open-Meteo forecast payload into the four numbers the widget shows.
 * Separated from the fetch so the shape can be tested without a network.
 */
export function parseForecast(payload, place, unit) {
  const current = payload?.current ?? {};
  const daily = payload?.daily ?? {};

  const temperature = Math.round(Number(current.temperature_2m));
  if (!Number.isFinite(temperature)) throw new Error("The forecast came back without a temperature.");

  const { text, icon } = describeCode(current.weather_code);

  return {
    place,
    unit,
    temperature,
    text,
    icon,
    high: round(daily.temperature_2m_max?.[0]),
    low: round(daily.temperature_2m_min?.[0]),
    at: Date.now(),
  };
}

const round = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : null);

/** True when a cached reading is too old to show. */
export const isStale = (cached, now = Date.now()) =>
  !cached || !Number.isFinite(cached.at) || now - cached.at > CACHE_MS;

/**
 * Resolves a typed place name to coordinates.
 * @returns {Promise<{name: string, latitude: number, longitude: number}>}
 */
export async function findPlace(query, signal) {
  const url = `${GEOCODE}?name=${encodeURIComponent(query)}&count=1&format=json`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Could not look that place up (${response.status}).`);

  const body = await response.json();
  const hit = body?.results?.[0];
  if (!hit) throw new Error(`No place called "${query}" was found.`);

  // The admin area and country disambiguate the dozens of Springfields.
  const name = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", ");
  return { name, latitude: hit.latitude, longitude: hit.longitude };
}

export async function fetchWeather({ latitude, longitude, name, unit = "celsius" }, signal) {
  const url =
    `${FORECAST}?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=${encodeURIComponent(unit)}&timezone=auto&forecast_days=1`;

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The forecast service returned ${response.status}.`);

  return parseForecast(await response.json(), name, unit);
}
