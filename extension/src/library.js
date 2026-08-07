// Saved prompts, and the `{{variable}}` handling that makes them worth saving.
//
// Pure — the storage lives in settings.js. A template is just a string; the
// only clever part is knowing where its blanks are so the input can select the
// first one for you to type over.

/** `{{ anything but braces }}`, non-greedy so two on one line stay separate. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * @param {string} template
 * @returns {Array<{start: number, end: number, name: string}>} in document order
 */
export function placeholders(template) {
  const text = String(template ?? "");
  const found = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    found.push({ start: match.index, end: match.index + match[0].length, name: match[1] });
  }
  return found;
}

/** The names a template asks for, deduplicated, in order of first appearance. */
export function variableNames(template) {
  const seen = new Set();
  const names = [];
  for (const { name } of placeholders(template)) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * The next blank at or after `from`, so Tab can walk them left to right.
 * @returns {{start: number, end: number, name: string}|null}
 */
export function nextPlaceholder(template, from = 0) {
  return placeholders(template).find((p) => p.start >= from) ?? null;
}

/** Substitutes by name; anything unanswered keeps its braces so it stays visible. */
export function fill(template, values = {}) {
  return String(template ?? "").replace(PLACEHOLDER, (whole, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}

/**
 * Matches a saved prompt against what has been typed after a leading `/`.
 * Prefix-first, then anywhere in the name, then anywhere in the body — so
 * typing the start of a name always beats an incidental hit further in.
 */
export function findTemplates(templates, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  const scored = [];

  for (const template of templates) {
    const name = String(template.name ?? "").toLowerCase();
    const body = String(template.text ?? "").toLowerCase();

    let rank = null;
    if (!needle) rank = 0;
    else if (name.startsWith(needle)) rank = 3;
    else if (name.includes(needle)) rank = 2;
    else if (body.includes(needle)) rank = 1;

    if (rank !== null) scored.push({ template, rank });
  }

  return scored.sort((a, b) => b.rank - a.rank).map((hit) => hit.template);
}

/**
 * `/name rest of line` → the template plus whatever was typed after it.
 * Returns null when the input is not a slash command at all.
 */
export function parseSlash(value) {
  const text = String(value ?? "");
  if (!text.startsWith("/")) return null;
  const [, name = "", rest = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
  return { name, rest };
}
