// The first-run question — "Where should questions go?" — as pure decisions.
//
// Whether to ask is settled once, by the service worker when Chrome installs
// or updates the extension, because only that moment can tell a new profile
// from an existing one: both look like an empty `onboarding` key to the page.
// An update marks the question answered, so nobody who already chose a
// destination is ever asked again.

import { CHATGPT, CLAUDE, PERPLEXITY, ANSWER_MODE, AUTO, isHandoff } from "./router.js";

export const PENDING = "pending";
export const DONE = "done";

/** What the picker offers, in order; the first is preselected. */
export const CHOICES = [CHATGPT, CLAUDE, PERPLEXITY, ANSWER_MODE];
export const DEFAULT_CHOICE = CHATGPT;

/**
 * The storage patch for a `chrome.runtime.onInstalled` event, or null for none.
 *
 * @param {string} reason   the event's `reason`
 * @param {{onboarding?: string}} stored  what is already in storage
 */
export function installPatch(reason, stored = {}) {
  if (stored.onboarding === PENDING || stored.onboarding === DONE) return null;
  if (reason === "install") return { onboarding: PENDING };
  // "update", "chrome_update", "shared_module_update": an existing profile.
  return { onboarding: DONE };
}

export const needsPicker = (stored) => stored?.onboarding === PENDING;

/**
 * The storage patch for answering the picker. The routing mode always becomes
 * the choice. A hand-off choice also becomes where Answer here sends a question
 * it cannot answer, so the two settings never disagree on day one. Anything
 * unrecognised — a closed dialog, a stale build — is the default.
 */
export function choicePatch(choice) {
  if (choice === AUTO) return { mode: AUTO, onboarding: DONE };
  const mode = CHOICES.includes(choice) ? choice : DEFAULT_CHOICE;
  return isHandoff(mode) ? { mode, fallbackMode: mode, onboarding: DONE } : { mode, onboarding: DONE };
}
