// Top sites and recently-closed tabs.
//
// Both are optional permissions, requested at the click that turns them on —
// same rule as `history` in Phase 3. Neither is in the install prompt.
//
// Everything read here is a URL and a title, and titles are attacker-
// influenceable, so nothing from this file is ever treated as markup.

const TOP_SITES = { permissions: ["topSites"] };

// `sessions` alone returns closed tabs with **no url and no title** — those two
// fields are gated on `tabs`, exactly as they are on chrome.tabs. Verified
// directly: with `sessions` only, getRecentlyClosed() yields `[{}]`. So this
// feature genuinely costs the "Read your browsing history" prompt, which is why
// it is a separate opt-in from top sites rather than bundled with them. See
// docs/ROADMAP.md Phase 5.
const SESSIONS = { permissions: ["sessions", "tabs"] };

const has = async (needed) => {
  if (!globalThis.chrome?.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains(needed);
  } catch {
    return false;
  }
};

const request = async (needed) => {
  if (!globalThis.chrome?.permissions?.request) return false;
  try {
    return await chrome.permissions.request(needed);
  } catch {
    return false;
  }
};

export const hasTilesAccess = () => has(TOP_SITES);
export const requestTilesAccess = () => request(TOP_SITES);
export const hasClosedTabsAccess = () => has(SESSIONS);
export const requestClosedTabsAccess = () => request(SESSIONS);

/** @returns {Promise<Array<{url: string, title: string}>>} */
export async function readTopSites(limit = 8) {
  if (!globalThis.chrome?.topSites?.get) return [];
  try {
    const sites = await chrome.topSites.get();
    return sites.filter((s) => isWebLink(s.url)).slice(0, limit).map((s) => ({
      url: s.url,
      title: s.title || hostOf(s.url),
    }));
  } catch {
    return [];
  }
}

/** @returns {Promise<Array<{url: string, title: string, at: number}>>} */
export async function readRecentlyClosed(limit = 8) {
  if (!globalThis.chrome?.sessions?.getRecentlyClosed) return [];
  try {
    const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
    const out = [];

    for (const session of sessions) {
      // A closed window carries its tabs; a closed tab is one on its own.
      const tabs = session.tab ? [session.tab] : (session.window?.tabs ?? []);
      for (const tab of tabs) {
        if (!isWebLink(tab.url)) continue;
        out.push({
          url: tab.url,
          title: tab.title || hostOf(tab.url),
          at: (session.lastModified ?? 0) * 1000, // seconds in this API, ms everywhere else
        });
      }
    }
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * The same rule the classifier enforces: only http(s) is ever navigable from
 * this page. `chrome://`, `file://` and friends turn up in both of these APIs.
 */
function isWebLink(url) {
  return /^https?:\/\//i.test(String(url ?? ""));
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
