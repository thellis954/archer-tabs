// The time, the greeting and the date under it.
//
// Pure: every function takes the moment rather than reading the clock, so the
// wording can be tested at 5am without waiting until 5am.

/**
 * Greeting bands. Chosen so "night" covers the small hours rather than being a
 * synonym for evening — someone reading this at 1am is not having an evening.
 */
const BANDS = [
  { from: 5, until: 12, greeting: "Good morning" },
  { from: 12, until: 17, greeting: "Good afternoon" },
  { from: 17, until: 22, greeting: "Good evening" },
];

export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  return BANDS.find((b) => hour >= b.from && hour < b.until)?.greeting ?? "Good night";
}

/**
 * @param {Date} date
 * @param {{locale?: string, timeZone?: string, hour12?: boolean}} [options]
 * @returns {{time: string, greeting: string, date: string}}
 */
export function describeMoment(date = new Date(), options = {}) {
  const locale = options.locale ?? undefined; // undefined = the browser's own
  const timeZone = options.timeZone ?? currentTimeZone();

  const time = date.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(options.hour12 === undefined ? {} : { hour12: options.hour12 }),
  });

  const day = date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });

  return {
    time,
    greeting: greetingFor(date),
    // The zone is worth showing: a new tab is often the first thing you look at
    // on a machine in a different one.
    date: timeZone ? `${day} · ${timeZone.replace(/_/g, " ")}` : day,
  };
}

export function currentTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * Milliseconds until the top of the next minute.
 *
 * The clock only shows minutes, so ticking every second would repaint 59 times
 * for nothing; aligning to the boundary also stops the display sitting a second
 * behind the system clock.
 */
export function msToNextMinute(date = new Date()) {
  return 60_000 - (date.getSeconds() * 1000 + date.getMilliseconds());
}
