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

/**
 * How long after a launch a conversation may appear and still be attributed to
 * it. Deliberately tight: the site mints the `/c/<uuid>` URL within seconds of
 * a prompt, so anything older is more likely a coincidence than a cause — and
 * the wider this is, the more unrelated launches compete to explain a row.
 */
export const BIND_WINDOW_MS = 2 * 60_000;

const CONVERSATION_URL = /^https:\/\/chatgpt\.com\/c\/([0-9a-f-]{36})(?:[/?#]|$)/i;

/** @returns {string|null} the conversation UUID, lowercased. */
export function conversationId(url) {
  const found = CONVERSATION_URL.exec(String(url ?? ""));
  return found ? found[1].toLowerCase() : null;
}

/** The canonical address of a conversation, rebuilt rather than passed through. */
export const conversationURL = (id) => `https://chatgpt.com/c/${id}`;

/**
 * @param {object} input
 * @param {Array<{url: string, title?: string, lastVisitTime?: number, firstVisitTime?: number}>} input.visits
 * @param {Array<{text: string, at: number}>} input.launches
 * @param {string[]} [input.pinned]
 * @param {string[]} [input.dismissed]
 * @param {number}   [input.limit]
 * @returns {Array<object>} rows, pinned first then most recent, capped at `limit`
 */
export function buildRows({ visits = [], launches = [], pinned = [], dismissed = [], limit = 6 } = {}) {
  const dropped = new Set(dismissed);
  const conversations = collapseVisits(visits).filter((c) => !dropped.has(c.id));

  // Oldest first, so "the latest launch that precedes this conversation" is a
  // forward scan and each launch can be spent at most once.
  const log = [...launches].filter((l) => l && l.text).sort((a, b) => a.at - b.at);
  const spent = bindLaunches(conversations, log);

  const rows = [
    ...conversations,
    ...unboundPrompts(log, spent, dropped),
  ];

  const isPinned = new Set(pinned);
  for (const row of rows) row.pinned = isPinned.has(row.id);

  rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at);
  return rows.slice(0, limit);
}

function collapseVisits(visits) {
  const byId = new Map();

  for (const visit of visits) {
    const id = conversationId(visit?.url);
    if (!id) continue;

    // Chrome records the tab title as it was at visit time. Before the model
    // names the conversation that is just "ChatGPT", which is no use as a row.
    const title = String(visit.title ?? "").trim();
    if (!title || title.toLowerCase() === "chatgpt") continue;

    const last = Number(visit.lastVisitTime) || 0;
    const first = Number(visit.firstVisitTime ?? visit.lastVisitTime) || 0;
    const existing = byId.get(id);

    if (!existing) {
      byId.set(id, { kind: CONVERSATION, id, url: conversationURL(id), title, at: last, firstVisit: first });
      continue;
    }
    // The newest visit wins the title — conversations get renamed.
    if (last > existing.at) {
      existing.at = last;
      existing.title = title;
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
  row.kind === CONVERSATION ? `${row.title} ${row.prompt ?? ""}` : row.text;

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
