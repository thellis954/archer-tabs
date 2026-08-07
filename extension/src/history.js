// The only place that touches chrome.history, and the only place that asks for
// the permission to do so.
//
// `history` is an *optional* permission: it is not in the install-time prompt,
// and Chrome asks for it the moment the user turns recent conversations on —
// never before. Archer reads nothing else from history: the query is scoped to
// chatgpt.com conversation URLs and every other result is dropped before it is
// looked at. See docs/ROADMAP.md §3.3 and the permissions ledger.

import { identify, PROVIDERS } from "./conversations.js";

const NEEDED = { permissions: ["history"] };

/** How far back to look. A month is what the reference page's list spans. */
const WINDOW_DAYS = 30;
const MAX_RESULTS = 300;

export async function hasHistoryAccess() {
  if (!globalThis.chrome?.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains(NEEDED);
  } catch {
    return false;
  }
}

/**
 * Must be called from a user gesture — Chrome refuses otherwise, and the
 * refusal is silent. The onboarding row's click handler is that gesture.
 * @returns {Promise<boolean>} whether access is now granted
 */
export async function requestHistoryAccess() {
  if (!globalThis.chrome?.permissions?.request) return false;
  try {
    return await chrome.permissions.request(NEEDED);
  } catch {
    return false;
  }
}

export async function revokeHistoryAccess() {
  if (!globalThis.chrome?.permissions?.remove) return false;
  try {
    return await chrome.permissions.remove(NEEDED);
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<Array<{url: string, title: string, lastVisitTime: number, firstVisitTime: number}>>}
 */
export async function readConversationVisits() {
  if (!globalThis.chrome?.history?.search) return [];

  // One query per host rather than one for "chatgpt.com/c/". Chrome's history
  // search is a loose text match that tokenises on punctuation, so a query with
  // slashes in it is unreliable — searching the bare host and filtering here is
  // both broader and exact.
  const queries = PROVIDERS.flatMap((p) => [p.query, ...(p.extraQueries ?? [])]);
  const startTime = Date.now() - WINDOW_DAYS * 864e5;

  let results;
  try {
    const batches = await Promise.all(
      queries.map((text) =>
        chrome.history.search({ text, startTime, maxResults: MAX_RESULTS }).catch(() => []),
      ),
    );
    results = batches.flat();
  } catch {
    // Permission revoked between the check and the call.
    return [];
  }

  // Narrow to actual conversation URLs, and drop the duplicates the overlapping
  // queries produce, before anything else is read off these records.
  const seen = new Set();
  const conversations = results.filter((item) => {
    if (!identify(item.url) || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });

  // The *first* visit is what a launch has to precede to have caused it;
  // history.search only reports the last one.
  return Promise.all(
    conversations.map(async (item) => ({
      url: item.url,
      title: item.title ?? "",
      lastVisitTime: item.lastVisitTime ?? 0,
      firstVisitTime: await firstVisitTime(item.url, item.lastVisitTime ?? 0),
    })),
  );
}

async function firstVisitTime(url, fallback) {
  try {
    const visits = await chrome.history.getVisits({ url });
    const times = visits.map((v) => v.visitTime).filter(Boolean);
    return times.length ? Math.min(...times) : fallback;
  } catch {
    return fallback;
  }
}
