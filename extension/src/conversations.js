// Reconstructs the suggestion rows from the two sources we are entitled to:
// Chrome's own history, and Archer's local launch log. See docs/ROADMAP.md §3.3
// for why there is no third source — no sanctioned API exposes ChatGPT
// conversation history, and riding the site's session cookie is not a route
// this project takes.
//
// Pure and total, like classify.js and router.js: the chrome.* calls live in
// history.js, and everything decided here is decided from plain data.

export const CONVERSATION = "conversation";
export const PROMPT_ROW = "prompt";
/** A frequently-visited site (chrome.topSites). */
export const SITE = "site";
/** A tab you closed (chrome.sessions). */
export const CLOSED = "closed";

/** Row kinds that are a link to follow rather than a prompt to re-ask. */
export const LINK_KINDS = new Set([CONVERSATION, SITE, CLOSED]);

/**
 * How long after a launch a conversation may appear and still be attributed to
 * it. Deliberately tight: the site mints the `/c/<uuid>` URL within seconds of
 * a prompt, so anything older is more likely a coincidence than a cause — and
 * the wider this is, the more unrelated launches compete to explain a row.
 */
export const BIND_WINDOW_MS = 2 * 60_000;

/**
 * The assistants whose conversations Archer can recognise in history.
 *
 * Host is matched by parsing the URL and comparing the host exactly — never by
 * regex against the whole string, which is how `chatgpt.com.evil.com/c/<uuid>`
 * would otherwise pass and become a row's link target.
 *
 * The path patterns are deliberately generous about prefixes: a conversation
 * with a custom GPT lives at `/g/g-xxxx/c/<uuid>`, and matching only `/c/<uuid>`
 * silently dropped every one of them.
 */
export const PROVIDERS = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    // chat.openai.com is the old address. It still fills a lot of history, and
    // the conversations are the same ones.
    hosts: ["chatgpt.com", "chat.openai.com"],
    path: /^\/(?:g\/[^/]+\/)?c\/([0-9a-f-]{36})(?:[/?#]|$)/i,
    url: (id) => `https://chatgpt.com/c/${id}`,
    // What to search history for. Chrome's history search is a loose text
    // match, so this is the broad net; `path` is the actual filter.
    query: "chatgpt.com",
    extraQueries: ["chat.openai.com"],
  },
  {
    id: "claude",
    label: "Claude",
    hosts: ["claude.ai"],
    path: /^\/chat\/([0-9a-f-]{36})(?:[/?#]|$)/i,
    url: (id) => `https://claude.ai/chat/${id}`,
    query: "claude.ai",
  },
];

/**
 * @returns {{provider: object, id: string, url: string}|null}
 */
export function identify(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ""));
  } catch {
    return null;
  }
  // https only: these are link targets clicked from a privileged origin.
  if (parsed.protocol !== "https:") return null;

  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  const provider = PROVIDERS.find((p) => p.hosts.includes(host));
  if (!provider) return null;

  const found = provider.path.exec(parsed.pathname);
  if (!found) return null;

  const id = found[1].toLowerCase();
  return { provider, id, url: provider.url(id) };
}

/** @returns {string|null} the conversation UUID, lowercased. */
export function conversationId(url) {
  return identify(url)?.id ?? null;
}

/** The canonical address of a conversation, rebuilt rather than passed through. */
export const conversationURL = (url) => identify(url)?.url ?? null;

/**
 * @param {object} input
 * @param {Array<{url: string, title?: string, lastVisitTime?: number, firstVisitTime?: number}>} input.visits
 * @param {Array<{text: string, at: number}>} input.launches
 * @param {string[]} [input.pinned]
 * @param {string[]} [input.dismissed]
 * @param {number}   [input.limit]
 * @returns {Array<object>} rows, pinned first then most recent, capped at `limit`
 */
export function buildRows({
  visits = [],
  launches = [],
  sites = [],
  closed = [],
  pinned = [],
  dismissed = [],
  limit = 8,
} = {}) {
  const dropped = new Set(dismissed);
  const conversations = collapseVisits(visits).filter((c) => !dropped.has(c.id));

  // Oldest first, so "the latest launch that precedes this conversation" is a
  // forward scan and each launch can be spent at most once.
  const log = [...launches].filter((l) => l && l.text).sort((a, b) => a.at - b.at);
  const spent = bindLaunches(conversations, log);

  // Named *after* binding, because the best name for a conversation Chrome
  // never titled is the prompt that started it — which is only known once a
  // launch has been bound to it.
  for (const conversation of conversations) {
    if (conversation.title) continue;
    conversation.title = conversation.prompt || `${conversation.provider} conversation`;
  }

  const recall = [...conversations, ...unboundPrompts(log, spent, dropped)];
  const browsing = browsingRows(sites, closed, dropped, recall);

  const isPinned = new Set(pinned);
  for (const row of [...recall, ...browsing]) row.pinned = isPinned.has(row.id);

  const byRecency = (a, b) => b.at - a.at;
  recall.sort(byRecency);
  browsing.sort(byRecency);

  // Pinning is an explicit instruction, so it outranks everything — including
  // the grouping below. Among the rest, what you asked beats where you have
  // been: this is a recall surface first, and top sites are here to fill the
  // space rather than to compete for it.
  const rest = [...recall, ...browsing].filter((r) => !r.pinned);
  const top = [...recall, ...browsing].filter((r) => r.pinned).sort(byRecency);

  return [...top, ...rest].slice(0, limit);
}

function browsingRows(sites, closed, dropped, recall) {
  const rows = [];
  // A conversation you can already reach as a row does not need a second entry
  // as "a site you visit a lot".
  const seen = new Set(recall.map((r) => r.url).filter(Boolean));

  for (const tab of closed ?? []) {
    if (!tab?.url || seen.has(tab.url)) continue;
    seen.add(tab.url);
    const row = { kind: CLOSED, id: `closed:${tab.url}`, url: tab.url, title: tab.title ?? "", at: Number(tab.at) || 0 };
    if (!dropped.has(row.id)) rows.push(row);
  }

  for (const site of sites ?? []) {
    if (!site?.url || seen.has(site.url)) continue;
    seen.add(site.url);
    // topSites reports no times at all, so these carry no recency to sort by.
    const row = { kind: SITE, id: `site:${site.url}`, url: site.url, title: site.title ?? "", at: 0 };
    if (!dropped.has(row.id)) rows.push(row);
  }

  return rows;
}

/** "ChatGPT", "Claude", "Claude.ai" — a tab that was never named. */
function isBareProductName(title) {
  const flat = title.toLowerCase().replace(/[\s.]/g, "");
  return ["chatgpt", "claude", "claudeai", "openai", "newchat"].includes(flat);
}

function collapseVisits(visits) {
  const byId = new Map();

  for (const visit of visits) {
    const found = identify(visit?.url);
    if (!found) continue;
    const { provider, id, url } = found;

    // Chrome records the tab title as it was at visit time, and the browser's
    // own tab title often carries a suffix.
    //
    // **A conversation with no usable title is kept, not dropped.** These sites
    // are single-page apps: the address becomes /c/<id> the moment you send the
    // first message, which is *before* the model has named the chat, so what
    // Chrome stores is very often the bare product name and it never revises
    // it. Dropping those made most real conversations invisible — the whole
    // feature looked like it pulled nothing. A row that reads "ChatGPT
    // conversation" is worth far more than no row at all, and buildRows gives
    // it a better name below if a prompt of yours can be bound to it.
    const title = String(visit.title ?? "")
      .replace(/\s*[|·—-]\s*(ChatGPT|Claude)\s*$/i, "")
      .trim();
    const usable = title && !isBareProductName(title) ? title : "";

    const last = Number(visit.lastVisitTime) || 0;
    const first = Number(visit.firstVisitTime ?? visit.lastVisitTime) || 0;
    const existing = byId.get(id);

    if (!existing) {
      byId.set(id, {
        kind: CONVERSATION,
        id,
        url,
        title: usable,
        at: last,
        firstVisit: first,
        provider: provider.label,
      });
      continue;
    }
    // The newest visit wins the title — conversations get renamed. But any real
    // title beats none, whenever it was recorded: the visit that carries the
    // name is usually an older one, for the same reason as above.
    if (last > existing.at) {
      existing.at = last;
      if (usable) existing.title = usable;
    } else if (usable && !existing.title) {
      existing.title = usable;
    }
    if (first && (!existing.firstVisit || first < existing.firstVisit)) existing.firstVisit = first;
  }

  return [...byId.values()];
}

/**
 * Attaches `prompt` to each conversation it can explain.
 *
 * Order-preserving: the n-th conversation gets the n-th launch still in play,
 * never a later one. The obvious alternative — "the launch closest before this
 * conversation" — reverses the pairing whenever several prompts are launched
 * before any of their conversations resolve, because timestamps that close
 * together carry no signal but their *order* does. Both agree on the normal
 * rhythm (ask, land, ask, land); they differ only where order is the only
 * evidence left, and there order should win.
 *
 * @returns {Set<number>} the spent launch indices
 */
function bindLaunches(conversations, log) {
  const spent = new Set();
  let next = 0;

  for (const conversation of [...conversations].sort((a, b) => a.firstVisit - b.firstVisit)) {
    // Launches too old to explain this conversation can't explain any later one
    // either, so they are dropped rather than skipped.
    while (next < log.length && conversation.firstVisit - log[next].at > BIND_WINDOW_MS) next++;

    if (next < log.length && log[next].at <= conversation.firstVisit) {
      conversation.prompt = log[next].text;
      spent.add(next);
      next++;
    }
  }
  return spent;
}

/**
 * Launches that never became a conversation we can see — asked in Search mode,
 * asked before the history permission was granted, or asked on a day Chrome
 * has since forgotten. They are still worth re-asking, so they get their own
 * row kind and need no permission at all.
 */
function unboundPrompts(log, spent, dropped) {
  const rows = [];
  const seen = new Set();

  for (let i = log.length - 1; i >= 0; i--) {
    if (spent.has(i)) continue;
    const key = log[i].text.toLowerCase();
    if (seen.has(key)) continue; // repeated prompts collapse to the newest
    seen.add(key);

    const row = { kind: PROMPT_ROW, id: `prompt:${log[i].at}`, text: log[i].text, at: log[i].at };
    if (!dropped.has(row.id)) rows.push(row);
  }
  return rows;
}

/** The text a row is matched and displayed by. */
export const rowText = (row) =>
  row.kind === PROMPT_ROW ? row.text : `${row.title ?? ""} ${row.prompt ?? row.url ?? ""}`;

/**
 * Subsequence match, ranked. Typing `evcl` finds "Evaluate Claude" — the same
 * gesture a command palette gives you, over rows you already have locally.
 */
export function filterRows(rows, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return rows;

  return rows
    .map((row) => ({ row, score: score(rowText(row), needle) }))
    .filter((hit) => hit.score !== null)
    .sort((a, b) => b.score - a.score || Number(b.row.pinned) - Number(a.row.pinned) || b.row.at - a.row.at)
    .map((hit) => hit.row);
}

function score(haystack, needle) {
  const text = haystack.toLowerCase();
  let total = 0;
  let from = 0;
  let streak = 0;

  for (const ch of needle) {
    const at = text.indexOf(ch, from);
    if (at === -1) return null;
    // Contiguous matches are worth more than scattered ones, and a match near
    // where we were already looking beats one far down the string.
    streak = at === from ? streak + 1 : 0;
    total += 10 + streak * 5 - Math.min(at - from, 20);
    from = at + 1;
  }
  return total;
}
