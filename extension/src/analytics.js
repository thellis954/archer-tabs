// What you actually ask, computed from the launch log on this device.
//
// Nothing here leaves the browser and nothing here talks to the network — it is
// arithmetic over an array that was already sitting in chrome.storage.local.
// Pure, so the shape of the summary is testable without a page.

/** Words too common to be interesting in a "what do you ask about" list. */
const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those of in on at to for from with without by " +
   "is are was were be been being do does did doing have has had how what when where which who whom " +
   "why can could should would will shall may might must i me my we our you your it its as not no " +
   "so up out about into over under again just also very s t don now")
    .split(" "),
);

/**
 * @param {Array<{text: string, at: number}>} launches
 * @returns {object} a summary safe to render straight into the page
 */
export function summarise(launches = []) {
  const entries = (launches ?? []).filter((l) => l && typeof l.text === "string" && l.text.trim());

  if (!entries.length) {
    return { total: 0, days: 0, perDay: 0, averageWords: 0, topWords: [], byHour: new Array(24).fill(0), busiestHour: null, firstAt: null, lastAt: null };
  }

  const times = entries.map((l) => Number(l.at) || 0).filter(Boolean).sort((a, b) => a - b);
  const byHour = new Array(24).fill(0);
  const counts = new Map();
  let words = 0;

  for (const entry of entries) {
    const parts = entry.text.trim().split(/\s+/);
    words += parts.length;

    for (const raw of parts) {
      // Keep letters and digits, drop the punctuation people type around words.
      const word = raw.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }

    if (entry.at) byHour[new Date(entry.at).getHours()]++;
  }

  const spanDays = times.length
    ? Math.max(1, Math.ceil((times.at(-1) - times[0]) / 864e5) || 1)
    : 1;

  return {
    total: entries.length,
    days: spanDays,
    perDay: Number((entries.length / spanDays).toFixed(1)),
    averageWords: Number((words / entries.length).toFixed(1)),
    topWords: [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([word, count]) => ({ word, count })),
    byHour,
    busiestHour: byHour.some(Boolean) ? byHour.indexOf(Math.max(...byHour)) : null,
    firstAt: times[0] ?? null,
    lastAt: times.at(-1) ?? null,
  };
}

/**
 * The launch log as Markdown, newest first — a natural drop into a notes vault.
 *
 * Prompts are fenced rather than inlined: they routinely contain `#`, `-`, `|`
 * and backticks, and a prompt that silently becomes a heading in someone's
 * notes is a worse export than a slightly plainer one.
 */
export function toMarkdown(launches = [], { title = "Archer — prompt history", now = null } = {}) {
  const entries = (launches ?? [])
    .filter((l) => l && typeof l.text === "string" && l.text.trim())
    .slice()
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));

  const lines = [`# ${title}`, ""];
  if (now) lines.push(`Exported ${new Date(now).toISOString().slice(0, 10)}.`, "");
  lines.push(`${entries.length} prompt${entries.length === 1 ? "" : "s"}.`, "");

  let day = null;
  for (const entry of entries) {
    const stamp = entry.at ? new Date(entry.at) : null;
    const heading = stamp ? stamp.toISOString().slice(0, 10) : "Undated";

    if (heading !== day) {
      day = heading;
      lines.push(`## ${heading}`, "");
    }

    const time = stamp ? stamp.toTimeString().slice(0, 5) : "";
    lines.push(time ? `- \`${time}\`` : "-", "", "  ```", ...entry.text.split("\n").map((l) => `  ${l}`), "  ```", "");
  }

  return lines.join("\n");
}
