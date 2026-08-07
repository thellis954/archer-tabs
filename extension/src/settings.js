// Everything Archer remembers, which is deliberately very little: the routing
// mode, whether the default-engine hint has been dismissed, and a local log of
// the prompts launched from this page.
//
// `chrome.storage.local`, not `.sync`. The launch log is the wrong shape for
// sync — 8 KB per item and 100 KB total — and one store with one set of
// semantics is easier to reason about than two. Carrying settings between
// machines is the "settings import/export" idea parked in ROADMAP §4.5.
//
// Nothing here ever leaves the device.

import { AUTO, MODES } from "./router.js";

const KEY_MODE = "mode";
const KEY_NUDGE = "engineNudgeDismissed";
const KEY_LAUNCHES = "launches";

/** Enough to reconstruct a month of rows without letting the log grow forever. */
export const LAUNCH_LIMIT = 200;

// newtab.html opened as a plain file for development has no chrome.storage.
// An in-memory stand-in keeps the page working there instead of throwing.
const memory = new Map();
const fallback = {
  async get(defaults) {
    const out = {};
    for (const [k, v] of Object.entries(defaults)) out[k] = memory.has(k) ? memory.get(k) : v;
    return out;
  },
  async set(values) {
    for (const [k, v] of Object.entries(values)) memory.set(k, v);
  },
};

const store = () => globalThis.chrome?.storage?.local ?? fallback;

/** @returns {Promise<{mode: string, nudgeDismissed: boolean}>} */
export async function loadSettings() {
  const raw = await store().get({ [KEY_MODE]: AUTO, [KEY_NUDGE]: false });
  return {
    // A mode written by a newer version, or a corrupted one, falls back rather
    // than putting the page in a state with no routing rule.
    mode: MODES.includes(raw[KEY_MODE]) ? raw[KEY_MODE] : AUTO,
    nudgeDismissed: raw[KEY_NUDGE] === true,
  };
}

export async function saveMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
  await store().set({ [KEY_MODE]: mode });
}

export async function dismissEngineNudge() {
  await store().set({ [KEY_NUDGE]: true });
}

/**
 * Records a prompt launched through this page.
 *
 * This is Source B of docs/ROADMAP.md §3.3: Chrome's history will later show a
 * visit to `chatgpt.com/c/<uuid>` whose title is the conversation title, and
 * the launch that preceded it is the prompt that started it. Phase 3 does the
 * binding, when the `history` permission arrives; recording costs no permission
 * at all, so it starts now and the log has depth by the time it is read.
 */
export async function recordLaunch(text, at = Date.now()) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return;

  const { [KEY_LAUNCHES]: log } = await store().get({ [KEY_LAUNCHES]: [] });
  const next = Array.isArray(log) ? log.slice() : [];
  next.push({ text: trimmed, at });

  await store().set({ [KEY_LAUNCHES]: next.slice(-LAUNCH_LIMIT) });
}

/** @returns {Promise<Array<{text: string, at: number}>>} newest first. */
export async function readLaunches() {
  const { [KEY_LAUNCHES]: log } = await store().get({ [KEY_LAUNCHES]: [] });
  return (Array.isArray(log) ? log : []).slice().reverse();
}
