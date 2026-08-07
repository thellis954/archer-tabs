// The favorites bar.
//
// Pure: normalising what someone types into a tile, and working out what to
// draw on it. Storage lives in settings.js, rendering in newtab.js.

/**
 * Only http(s) is ever navigable from this page, so a favorite is only ever
 * http(s) — the same rule classify.js enforces for the search box. A tile is a
 * link the user clicks, so `javascript:` here would be as dangerous as it is
 * there.
 */
export function normaliseURL(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null; // the userinfo phishing shape
  return url.toString();
}

/** "https://www.github.com/x" → "github.com" */
export function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Second-level labels that are part of the suffix rather than the site:
 * `bbc.co.uk` is the BBC, not "Co".
 *
 * A proper answer needs the Public Suffix List, which is ~15k entries and far
 * too much weight for a fallback name the user can overwrite by typing one.
 * These cover the cases people actually bookmark.
 */
const SUFFIX_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne"]);

/**
 * A readable name when the user did not give one: the site's own label,
 * capitalised. "https://news.ycombinator.com" → "Ycombinator".
 */
export function nameFor(url, given = "") {
  const name = String(given ?? "").trim();
  if (name) return name;

  const host = hostOf(url);
  if (!host) return url;

  // Walk in from the right past the suffix, and take the label before it.
  const parts = host.split(".");
  let at = parts.length - 1;
  while (at > 0 && SUFFIX_LABELS.has(parts[at - 1].toLowerCase())) at--;

  const label = parts[Math.max(0, at - 1)] || parts[0];
  return label ? label[0].toUpperCase() + label.slice(1) : host;
}

/**
 * Two letters for the tile face.
 *
 * A monogram rather than a favicon: a real favicon needs either the `favicon`
 * permission or a network fetch per tile, and a letter drawn from the site's
 * own name works offline, in both themes, and at any size. Turning on real
 * icons is a settings toggle (docs/ROADMAP.md Phase 6).
 */
export function monogram(name) {
  const words = String(name ?? "").trim().split(/[\s._\-/]+/).filter(Boolean);
  if (!words.length) return "?";

  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();

  // One word: an internal capital is almost always the second half of a
  // compound name, and "GH" says GitHub in a way "GI" does not.
  const word = words[0];
  const inner = word.slice(1).search(/[A-Z0-9]/);
  if (inner !== -1) return (word[0] + word[inner + 1]).toUpperCase();

  return word.length === 1 ? word.toUpperCase() : word.slice(0, 2).toUpperCase();
}

/**
 * A stable hue per site, so a tile keeps its colour between sessions and two
 * different sites rarely collide. Deterministic — no storage, no randomness.
 */
export function hueFor(seed) {
  const text = String(seed ?? "");
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

/**
 * @param {Array} existing
 * @param {{url: string, name?: string}} input
 * @returns {{ok: true, favorites: Array} | {ok: false, reason: string}}
 */
export function addFavorite(existing, input) {
  const url = normaliseURL(input?.url);
  if (!url) return { ok: false, reason: "That does not look like a web address." };

  const list = Array.isArray(existing) ? existing : [];
  if (list.some((f) => f.url === url)) return { ok: false, reason: "That one is already here." };

  return { ok: true, favorites: [...list, { id: url, url, name: nameFor(url, input?.name) }] };
}

export const removeFavorite = (existing, id) =>
  (Array.isArray(existing) ? existing : []).filter((f) => f.id !== id);
