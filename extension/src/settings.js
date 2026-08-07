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
const KEY_PINNED = "pinned";
const KEY_DISMISSED = "dismissed";

/** Dismissals are a tidying gesture, not a tombstone list to keep forever. */
const DISMISSED_LIMIT = 300;

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

/** Forgets every logged prompt. Pins, saved prompts and settings are untouched. */
export async function clearLaunches() {
  await store().set({ [KEY_LAUNCHES]: [] });
}

/** @returns {Promise<Array<{text: string, at: number}>>} newest first. */
export async function readLaunches() {
  const { [KEY_LAUNCHES]: log } = await store().get({ [KEY_LAUNCHES]: [] });
  return (Array.isArray(log) ? log : []).slice().reverse();
}

// --- row state ----------------------------------------------------------------

/** @returns {Promise<{pinned: string[], dismissed: string[]}>} */
export async function readRowState() {
  const raw = await store().get({ [KEY_PINNED]: [], [KEY_DISMISSED]: [] });
  return {
    pinned: list(raw[KEY_PINNED]),
    dismissed: list(raw[KEY_DISMISSED]),
  };
}

/** @returns {Promise<boolean>} whether the row is pinned afterwards. */
export async function togglePinned(id) {
  const { pinned } = await readRowState();
  const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
  await store().set({ [KEY_PINNED]: next });
  return next.includes(id);
}

export async function dismissRow(id) {
  const { pinned, dismissed } = await readRowState();
  if (dismissed.includes(id)) return;

  await store().set({
    [KEY_DISMISSED]: [...dismissed, id].slice(-DISMISSED_LIMIT),
    // A dismissed row that is still pinned would come back the moment the
    // dismissal aged out of the list above.
    [KEY_PINNED]: pinned.filter((x) => x !== id),
  });
}

const list = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === "string") : []);

// --- inline answers -----------------------------------------------------------

const KEY_API = "apiKey";
const KEY_MODEL = "model";
const KEY_CAP = "tokenCap";
const KEY_RATE_IN = "rateInPerM";
const KEY_RATE_OUT = "rateOutPerM";
const KEY_SPEND = "spend";

/** Generous enough not to nag, small enough to notice a runaway. */
export const DEFAULT_TOKEN_CAP = 50_000;

/**
 * The key lives in chrome.storage.local and is read by the new tab page and the
 * options page only. It is never sent anywhere but api.openai.com, and there is
 * no server in this project to send it to.
 */
export async function loadAnswerSettings() {
  const raw = await store().get({
    [KEY_API]: "",
    [KEY_MODEL]: "",
    [KEY_CAP]: DEFAULT_TOKEN_CAP,
    [KEY_RATE_IN]: 0,
    [KEY_RATE_OUT]: 0,
  });
  return {
    apiKey: typeof raw[KEY_API] === "string" ? raw[KEY_API] : "",
    model: typeof raw[KEY_MODEL] === "string" ? raw[KEY_MODEL] : "",
    tokenCap: Number(raw[KEY_CAP]) >= 0 ? Number(raw[KEY_CAP]) : DEFAULT_TOKEN_CAP,
    rateInPerM: Number(raw[KEY_RATE_IN]) || 0,
    rateOutPerM: Number(raw[KEY_RATE_OUT]) || 0,
  };
}

export async function saveAnswerSettings(values) {
  const patch = {};
  if ("apiKey" in values) patch[KEY_API] = String(values.apiKey ?? "");
  if ("model" in values) patch[KEY_MODEL] = String(values.model ?? "");
  if ("tokenCap" in values) patch[KEY_CAP] = Math.max(0, Number(values.tokenCap) || 0);
  if ("rateInPerM" in values) patch[KEY_RATE_IN] = Math.max(0, Number(values.rateInPerM) || 0);
  if ("rateOutPerM" in values) patch[KEY_RATE_OUT] = Math.max(0, Number(values.rateOutPerM) || 0);
  await store().set(patch);
}

/**
 * The budget resets daily.
 *
 * The roadmap asked for a *per-session* cap, but a new tab page has no session:
 * every tab is a fresh document, and "this browser run" is not observable
 * without a service worker we otherwise do not need. A day is the honest
 * reading, and it is the one a person can actually reason about.
 */
export async function readSpend(today = dayStamp()) {
  const { [KEY_SPEND]: spend } = await store().get({ [KEY_SPEND]: null });
  if (!spend || spend.day !== today) return { day: today, tokens: 0 };
  return { day: today, tokens: Number(spend.tokens) || 0 };
}

export async function addSpend(tokens, today = dayStamp()) {
  const current = await readSpend(today);
  const next = { day: today, tokens: current.tokens + (Number(tokens) || 0) };
  await store().set({ [KEY_SPEND]: next });
  return next;
}

// --- the prompt library --------------------------------------------------------

const KEY_LIBRARY = "library";

/** @returns {Promise<Array<{id: string, name: string, text: string}>>} */
export async function readLibrary() {
  const { [KEY_LIBRARY]: saved } = await store().get({ [KEY_LIBRARY]: [] });
  if (!Array.isArray(saved)) return [];

  return saved
    .filter((t) => t && typeof t.name === "string" && typeof t.text === "string")
    .map((t) => ({ id: String(t.id ?? t.name), name: t.name, text: t.text }));
}

export async function saveLibrary(templates) {
  await store().set({ [KEY_LIBRARY]: templates });
}

/** Local calendar day — the boundary a person means when they say "today". */
export function dayStamp(at = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
