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
export const CHATGPT = "chatgpt";
export const SEARCH_MODE = "search";
export const ANSWER_MODE = "answer";
export const MODES = [AUTO, CHATGPT, SEARCH_MODE, ANSWER_MODE];

// `?q=` prefills the composer but does not reliably submit on its own — see the
// deferred content-script note in docs/ROADMAP.md Phase 2. Landing in the
// composer with the text already there is the honest degrade; a dead button
// would not be.
const CHATGPT_URL = "https://chatgpt.com/?q=";

/**
 * @param {string} raw   what the user typed
 * @param {{mode?: string, force?: "url"|"prompt"|null, canAnswer?: boolean}} [options]
 * @param options.canAnswer  whether an API key is set. Answer mode degrades to
 *                           a plain search without one, rather than failing.
 * @returns {{action: string, url?: string, text?: string}}
 */
export function route(raw, { mode = AUTO, force = null, canAnswer = false } = {}) {
  // Answer mode with no key is not an error state — the key can be cleared long
  // after the mode was chosen — so it quietly becomes the mode it would have
  // been. docs/ROADMAP.md Phase 4: "degrades cleanly to Phase 2 navigation".
  const effectiveMode = mode === ANSWER_MODE && !canAnswer ? AUTO : mode;

  // Search mode means "I am searching, not navigating", so it suppresses URL
  // detection entirely — it is the sticky form of ⌘+Enter. An explicit
  // modifier still wins over the mode, because it is the more recent intent.
  const effective = effectiveMode === SEARCH_MODE && force === null ? PROMPT : force;

  const verdict = classify(raw, effective);
  if (verdict.kind === EMPTY) return { action: NONE };
  if (verdict.kind === URL_KIND) return { action: NAVIGATE, url: verdict.url };

  if (effectiveMode === CHATGPT) {
    return { action: ASK, url: CHATGPT_URL + encodeURIComponent(verdict.text), text: verdict.text };
  }
  if (effectiveMode === ANSWER_MODE) {
    return { action: ANSWER, text: verdict.text };
  }
  return { action: SEARCH, text: verdict.text };
}
