// Turns "what you typed" plus "which mode you're in" into a single instruction.
//
// Like classify.js this is pure and total — no DOM, no chrome.* — so the whole
// routing table is unit-testable. newtab.js does nothing but carry out the
// verdict this returns.

import { classify, EMPTY, URL_KIND, PROMPT } from "./classify.js";

/** Nothing to do. */
export const NONE = "none";
/** Go to `url`. Only ever http(s) — classify.js guarantees it. */
export const NAVIGATE = "navigate";
/** Hand `text` to the user's default search engine via chrome.search. */
export const SEARCH = "search";
/** Go to `url` (a ChatGPT prompt link) and remember `text` was the prompt. */
export const ASK = "ask";
/** Answer `text` on this page, from the user's own API key. */
export const ANSWER = "answer";

export const AUTO = "auto";
export const GOOGLE = "google";
export const CHATGPT = "chatgpt";
export const CLAUDE = "claude";
export const PERPLEXITY = "perplexity";
export const SEARCH_MODE = "search";
export const ANSWER_MODE = "answer";
export const MODES = [AUTO, GOOGLE, CHATGPT, CLAUDE, PERPLEXITY, SEARCH_MODE, ANSWER_MODE];

/**
 * Where a prompt goes in each hand-off mode. Every one is a plain `?q=`
 * navigation — no content script, no host permission, and the query arrives in
 * the composer whether or not the site chooses to submit it for you.
 *
 * Naming these is nominative use: it is a list of destinations, the way a
 * browser's settings name search engines. No mark or styling of theirs is used.
 */
const TARGETS = {
  [GOOGLE]: "https://www.google.com/search?q=",
  [CHATGPT]: "https://chatgpt.com/?q=",
  [CLAUDE]: "https://claude.ai/new?q=",
  [PERPLEXITY]: "https://www.perplexity.ai/search?q=",
};

export const isHandoff = (mode) => Object.hasOwn(TARGETS, mode);

/** The destination's own name, for sentences like "Sent to Claude instead." */
const NAMES = {
  [GOOGLE]: "Google",
  [CHATGPT]: "ChatGPT",
  [CLAUDE]: "Claude",
  [PERPLEXITY]: "Perplexity",
};

export const targetName = (mode) => NAMES[mode] ?? "your search engine";

/** The `?q=` link for a hand-off mode, or null for any other mode. */
export const handoffURL = (mode, text) =>
  isHandoff(mode) ? TARGETS[mode] + encodeURIComponent(String(text ?? "").trim()) : null;

/**
 * Where answer mode sends a question when nothing can answer it on the page.
 * Only a hand-off qualifies: falling back to the default engine is the silent
 * search QA reported, and it is exactly what this setting exists to prevent.
 */
export const DEFAULT_FALLBACK = CHATGPT;
export const fallbackFor = (mode) => (isHandoff(mode) ? mode : DEFAULT_FALLBACK);

/**
 * What the search box should say in each mode.
 *
 * `docs/BRAND.md` fixed this at "Ask or type a URL" so a *default* placeholder
 * would not imply an affiliation with a provider. Reflecting a destination the
 * user has just chosen is the opposite: it is the box telling you where the
 * next Enter goes, which is the single most useful thing it can say.
 */
const PLACEHOLDERS = {
  [AUTO]: "Ask or type a URL",
  [GOOGLE]: "Search Google, or type a URL",
  [CHATGPT]: "Ask ChatGPT, or type a URL",
  [CLAUDE]: "Ask Claude, or type a URL",
  [PERPLEXITY]: "Ask Perplexity, or type a URL",
  [SEARCH_MODE]: "Search with your default engine",
  [ANSWER_MODE]: "Ask, and the answer appears here",
};

export const placeholderFor = (mode, canAnswer = true, fallback = DEFAULT_FALLBACK) =>
  PLACEHOLDERS[mode === ANSWER_MODE && !canAnswer ? fallbackFor(fallback) : mode] ?? PLACEHOLDERS[AUTO];

/**
 * @param {string} raw   what the user typed
 * @param {{mode?: string, force?: "url"|"prompt"|null, canAnswer?: boolean, fallback?: string}} [options]
 * @param options.canAnswer  whether anything can answer on the page — an API key
 *                           with a model, or Chrome's built-in model.
 * @param options.fallback   the hand-off answer mode uses when nothing can.
 * @returns {{action: string, url?: string, text?: string}}
 */
export function route(raw, { mode = AUTO, force = null, canAnswer = false, fallback = DEFAULT_FALLBACK } = {}) {
  // Answer mode with nothing to answer is not an error state — the key can be
  // cleared long after the mode was chosen — so the question goes to the
  // hand-off the user picked for that case. It used to become Auto, which sent
  // it to the default engine without a word (QA P2-2); newtab.js now says so.
  const effectiveMode = mode === ANSWER_MODE && !canAnswer ? fallbackFor(fallback) : mode;

  // Search mode means "I am searching, not navigating", so it suppresses URL
  // detection entirely — it is the sticky form of ⌘+Enter. An explicit
  // modifier still wins over the mode, because it is the more recent intent.
  const effective = effectiveMode === SEARCH_MODE && force === null ? PROMPT : force;

  const verdict = classify(raw, effective);
  if (verdict.kind === EMPTY) return { action: NONE };
  if (verdict.kind === URL_KIND) return { action: NAVIGATE, url: verdict.url };

  if (isHandoff(effectiveMode)) {
    // `?q=` prefills the composer but does not reliably submit on its own — see
    // the deferred content-script note in docs/ROADMAP.md Phase 2. Landing in
    // the composer with the text already there is the honest degrade; a dead
    // button would not be.
    return {
      action: ASK,
      url: handoffURL(effectiveMode, verdict.text),
      text: verdict.text,
    };
  }
  if (effectiveMode === ANSWER_MODE) {
    return { action: ANSWER, text: verdict.text };
  }
  return { action: SEARCH, text: verdict.text };
}
