// Every permission Archer can ask for, in one list, in plain language.
//
// The manifest asks for `search` and `storage` at install and nothing else.
// Everything below is optional: Chrome asks for it at the moment the feature is
// switched on, and this list is where it can be switched back off.
//
// The wording is the point. "topSites" tells a user nothing; "the sites you
// visit most, so they can appear as rows" tells them what they are agreeing to
// and what they lose by declining.

/**
 * @typedef {object} Grant
 * @property {string} id
 * @property {string} title
 * @property {string} why      what the feature does with it
 * @property {string} [cost]   the part worth reading twice, when there is one
 * @property {string[]} [permissions]
 * @property {string[]} [origins]
 */

/** @type {Grant[]} */
export const GRANTS = [
  {
    id: "history",
    title: "Recent conversations",
    permissions: ["history"],
    why: "Reads your browsing history so conversations you have already had can appear as rows. Archer only looks at chatgpt.com conversation addresses; every other entry is discarded before it is read.",
  },
  {
    id: "topSites",
    title: "Top sites",
    permissions: ["topSites"],
    why: "The sites you visit most, shown as rows you can pick back up.",
  },
  {
    id: "closedTabs",
    title: "Recently closed tabs",
    permissions: ["sessions", "tabs"],
    why: "Tabs you closed recently, shown as rows so you can reopen one.",
    cost: "Chrome will not tell an extension the title of a closed tab unless it can also read tab titles generally, so this one asks for more than the others. Chrome's own wording for it is \"read your browsing history\".",
  },
  {
    id: "clipboard",
    title: "Paste from the + menu",
    permissions: ["clipboardRead"],
    why: "Reads the clipboard when — and only when — you choose Paste in the + menu.",
  },
  {
    id: "favicons",
    title: "Site icons on favourites",
    permissions: ["favicon"],
    why: "Shows each favourite's real icon instead of its initials, read from the icon store Chrome already built from your own history. Nothing is fetched from the site — no request leaves your device — so a site Chrome has never seen keeps its initials.",
  },
  {
    id: "openai",
    title: "Inline answers",
    origins: ["https://api.openai.com/*"],
    why: "Lets the new tab page reach api.openai.com with your own key, so an answer can stream onto the page. The request goes straight from your browser; there is no Archer server in the path.",
  },
  {
    id: "weather",
    title: "Weather",
    origins: ["https://api.open-meteo.com/*", "https://geocoding-api.open-meteo.com/*"],
    why: "Looks up the place you typed and fetches its forecast from Open-Meteo, which needs no account and no API key. Your browser is never asked for its location.",
  },
];

/** The shape chrome.permissions wants. */
export const asRequest = (grant) => ({
  permissions: grant.permissions ?? [],
  origins: grant.origins ?? [],
});

export async function isGranted(grant) {
  if (!globalThis.chrome?.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains(asRequest(grant));
  } catch {
    return false;
  }
}

export async function grant(g) {
  if (!globalThis.chrome?.permissions?.request) return false;
  try {
    return await chrome.permissions.request(asRequest(g));
  } catch {
    return false;
  }
}

export async function revoke(g) {
  if (!globalThis.chrome?.permissions?.remove) return false;
  try {
    return await chrome.permissions.remove(asRequest(g));
  } catch {
    return false;
  }
}
