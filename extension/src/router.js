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

export const AUTO = "auto";
export const CHATGPT = "chatgpt";
export const SEARCH_MODE = "search";
export const MODES = [AUTO, CHATGPT, SEARCH_MODE];

// `?q=` prefills the composer but does not reliably submit on its own — see the
// deferred content-script note in docs/ROADMAP.md Phase 2. Landing in the
// composer with the text already there is the honest degrade; a dead button
// would not be.
const CHATGPT_URL = "https://chatgpt.com/?q=";

/**
 * @param {string} raw   what the user typed
 * @param {{mode?: string, force?: "url"|"prompt"|null}} [options]
 * @returns {{action: string, url?: string, text?: string}}
 */
export function route(raw, { mode = AUTO, force = null } = {}) {
  // Search mode means "I am searching, not navigating", so it suppresses URL
  // detection entirely — it is the sticky form of ⌘+Enter. An explicit
  // modifier still wins over the mode, because it is the more recent intent.
  const effective = mode === SEARCH_MODE && force === null ? PROMPT : force;

  const verdict = classify(raw, effective);
  if (verdict.kind === EMPTY) return { action: NONE };
  if (verdict.kind === URL_KIND) return { action: NAVIGATE, url: verdict.url };

  if (mode === CHATGPT) {
    return { action: ASK, url: CHATGPT_URL + encodeURIComponent(verdict.text), text: verdict.text };
  }
  return { action: SEARCH, text: verdict.text };
}
