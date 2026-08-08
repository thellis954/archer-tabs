import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRows,
  filterRows,
  conversationId,
  CONVERSATION,
  PROMPT_ROW,
  BIND_WINDOW_MS,
} from "../extension/src/conversations.js";

const UUID = "0f9c2a41-1b3d-4c8e-9a77-5e2b6d0c4a19";
const OTHER = "7a1e5c93-2d4f-4b6a-8c05-1f3e9b7d2a68";
const T = 1_700_000_000_000;

// --- conversationId ----------------------------------------------------------

test("recognises a conversation URL", () => {
  assert.equal(conversationId(`https://chatgpt.com/c/${UUID}`), UUID);
  assert.equal(conversationId(`https://chatgpt.com/c/${UUID}?share=1`), UUID);
  assert.equal(conversationId(`https://chatgpt.com/c/${UUID.toUpperCase()}`), UUID);
});

test("rejects anything that is not one", () => {
  for (const url of [
    "https://chatgpt.com/",
    "https://chatgpt.com/c/not-a-uuid",
    "https://evil.com/chatgpt.com/c/" + UUID,
    // Look-alike hosts must not slip through: this is used to build the row's
    // link target, so a false positive here is a phishing surface.
    `https://chatgpt.com.evil.com/c/${UUID}`,
    `http://chatgpt.com/c/${UUID}`,
    undefined,
    null,
    "",
  ]) {
    assert.equal(conversationId(url), null, String(url));
  }
});

// --- building rows -----------------------------------------------------------

const visit = (id, title, at, first = at) => ({
  url: `https://chatgpt.com/c/${id}`,
  title,
  lastVisitTime: at,
  firstVisitTime: first,
});

test("a titled conversation becomes a row", () => {
  const rows = buildRows({ visits: [visit(UUID, "Evaluate Claude vs rivals", T)] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, CONVERSATION);
  assert.equal(rows[0].title, "Evaluate Claude vs rivals");
  assert.equal(rows[0].url, `https://chatgpt.com/c/${UUID}`);
});

// These used to assert the opposite, and that assertion was the bug: dropping
// them made most real conversations invisible. The address becomes /c/<id> the
// moment you send the first message — before the model has named the chat — so
// what Chrome stores is very often the bare product name, and it never revises
// it. The row is what makes the conversation reachable; a mediocre name on a
// reachable row beats a perfect name on one that was never rendered.
test("an untitled or pre-rename visit is kept, and named for its provider", () => {
  for (const title of ["ChatGPT", "chatgpt", "   ", undefined, "New chat"]) {
    const rows = buildRows({ visits: [visit(UUID, title, T)] });
    assert.equal(rows.length, 1, JSON.stringify(title));
    assert.equal(rows[0].title, "ChatGPT conversation", JSON.stringify(title));
    assert.equal(rows[0].url, `https://chatgpt.com/c/${UUID}`);
  }
});

test("...and the prompt that started it is a better name than that", () => {
  const rows = buildRows({
    visits: [{ url: `https://chatgpt.com/c/${UUID}`, title: "ChatGPT", lastVisitTime: T, firstVisitTime: T }],
    launches: [{ text: "how do I fletch an arrow", at: T - 1000 }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "how do I fletch an arrow");
});

test("a real title still wins over the prompt", () => {
  const rows = buildRows({
    visits: [{ url: `https://chatgpt.com/c/${UUID}`, title: "Fletching", lastVisitTime: T, firstVisitTime: T }],
    launches: [{ text: "how do I fletch an arrow", at: T - 1000 }],
  });
  assert.equal(rows[0].title, "Fletching");
});

test("repeat visits collapse to one row, keeping the newest title", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Old name", T), visit(UUID, "Renamed later", T + 5000)],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Renamed later");
});

test("a real title beats a bare one whichever visit carried it", () => {
  // The visit that carries the real name is usually the *older* one — the name
  // arrives after the address does — so "newest wins" alone loses it.
  const rows = buildRows({
    visits: [visit(UUID, "Fletching an arrow", T), visit(UUID, "ChatGPT", T + 5000)],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Fletching an arrow");
});

test("the row link is rebuilt from the id, not passed through", () => {
  const rows = buildRows({
    visits: [{ url: `https://chatgpt.com/c/${UUID}?utm=spam#x`, title: "A", lastVisitTime: T }],
  });
  assert.equal(rows[0].url, `https://chatgpt.com/c/${UUID}`);
});

// --- binding launches to conversations ---------------------------------------

test("a launch just before the first visit becomes the description", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Evaluate Claude vs rivals", T)],
    launches: [{ text: "compare claude and its rivals", at: T - 4000 }],
  });
  assert.equal(rows[0].prompt, "compare claude and its rivals");
  assert.equal(rows.length, 1, "the bound launch does not also appear as its own row");
});

test("a launch outside the window does not bind", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Evaluate Claude vs rivals", T)],
    launches: [{ text: "unrelated", at: T - BIND_WINDOW_MS - 1 }],
  });
  assert.equal(rows[0].prompt, undefined);
  assert.equal(rows.length, 2, "it stays available as an ask-again row");
});

test("a launch after the conversation started cannot have caused it", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Evaluate Claude vs rivals", T)],
    launches: [{ text: "asked afterwards", at: T + 1000 }],
  });
  assert.equal(rows[0].prompt, undefined);
});

test("each launch is spent at most once", () => {
  const rows = buildRows({
    visits: [visit(UUID, "First", T, T), visit(OTHER, "Second", T + 2000, T + 2000)],
    launches: [{ text: "only one prompt", at: T - 1000 }],
  });
  const bound = rows.filter((r) => r.prompt);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].title, "First", "the earliest conversation claims it");
});

test("a launch that has aged out is passed over for a live one", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Evaluate Claude vs rivals", T)],
    launches: [
      { text: "much earlier", at: T - BIND_WINDOW_MS - 1 },
      { text: "right before", at: T - 2000 },
    ],
  });
  assert.equal(rows.find((r) => r.kind === CONVERSATION).prompt, "right before");
});

test("prompts launched in a burst keep their order", () => {
  // The case that motivated order-preserving binding: three prompts fired
  // before any of their conversations resolve. "Closest preceding launch"
  // pairs these exactly backwards, because a few milliseconds of separation
  // carries no signal and the sequence carries all of it.
  const THIRD = "3c5b7e21-8a4d-4f19-b6c0-2d9e1a7f3b85";
  const rows = buildRows({
    visits: [
      visit(UUID, "First conversation", T + 10_000),
      visit(OTHER, "Second conversation", T + 11_000),
      visit(THIRD, "Third conversation", T + 12_000),
    ],
    launches: [
      { text: "first prompt", at: T },
      { text: "second prompt", at: T + 1 },
      { text: "third prompt", at: T + 2 },
    ],
  });

  const pairs = Object.fromEntries(rows.map((r) => [r.title, r.prompt]));
  assert.deepEqual(pairs, {
    "First conversation": "first prompt",
    "Second conversation": "second prompt",
    "Third conversation": "third prompt",
  });
});

test("an unrelated launch does not steal a later conversation's prompt", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Evaluate Claude vs rivals", T)],
    launches: [
      { text: "a google search from ten minutes ago", at: T - 10 * 60_000 },
      { text: "the prompt that made it", at: T - 3000 },
    ],
  });
  assert.equal(rows.find((r) => r.kind === CONVERSATION).prompt, "the prompt that made it");
});

// --- prompt rows -------------------------------------------------------------

test("unbound launches become ask-again rows, newest first", () => {
  const rows = buildRows({
    launches: [
      { text: "older", at: T },
      { text: "newer", at: T + 1000 },
    ],
  });
  assert.deepEqual(rows.map((r) => r.text), ["newer", "older"]);
  assert.equal(rows[0].kind, PROMPT_ROW);
});

test("a repeated prompt collapses to its most recent ask", () => {
  const rows = buildRows({
    launches: [
      { text: "what is a nock", at: T },
      { text: "What Is A Nock", at: T + 1000 },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].at, T + 1000);
});

// --- pinning and dismissing --------------------------------------------------

test("pinned rows sort to the top regardless of age", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Ancient but pinned", T - 900_000), visit(OTHER, "Recent", T)],
    pinned: [UUID],
  });
  assert.equal(rows[0].title, "Ancient but pinned");
  assert.equal(rows[0].pinned, true);
  assert.equal(rows[1].pinned, false);
});

test("dismissed rows do not come back", () => {
  assert.equal(buildRows({ visits: [visit(UUID, "Gone", T)], dismissed: [UUID] }).length, 0);
  assert.equal(
    buildRows({ launches: [{ text: "gone", at: T }], dismissed: [`prompt:${T}`] }).length,
    0,
  );
});

test("dismissing a conversation frees its launch to stand on its own", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Evaluate Claude vs rivals", T)],
    launches: [{ text: "compare the tools", at: T - 4000 }],
    dismissed: [UUID],
  });
  assert.deepEqual(rows.map((r) => r.text), ["compare the tools"]);
});

test("the row cap is honoured", () => {
  // Eight since Phase 5: top sites and closed tabs share the list, and six left
  // no room for them once you had a day's worth of prompts.
  const launches = Array.from({ length: 20 }, (_, i) => ({ text: `q${i}`, at: T + i }));
  assert.equal(buildRows({ launches }).length, 8);
  assert.equal(buildRows({ launches, limit: 3 }).length, 3);
});

// --- top sites and closed tabs (Phase 5) -------------------------------------

const site = (url, title) => ({ url, title });

test("top sites and closed tabs become rows", () => {
  const rows = buildRows({
    sites: [site("https://news.example.com", "News")],
    closed: [{ url: "https://docs.example.com", title: "Docs", at: T }],
  });
  assert.deepEqual(rows.map((r) => r.kind), ["closed", "site"]);
  assert.equal(rows[0].title, "Docs");
});

test("what you asked outranks where you have been", () => {
  const rows = buildRows({
    launches: [{ text: "an old prompt", at: T - 900_000 }],
    sites: [site("https://news.example.com", "News")],
    closed: [{ url: "https://docs.example.com", title: "Docs", at: T }],
  });
  assert.equal(rows[0].kind, PROMPT_ROW, "even though the closed tab is newer");
});

test("a site that is already a conversation row is not repeated", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Evaluate Claude vs rivals", T)],
    sites: [site(`https://chatgpt.com/c/${UUID}`, "Evaluate Claude vs rivals")],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, CONVERSATION);
});

test("closed tabs and top sites do not duplicate each other", () => {
  const rows = buildRows({
    sites: [site("https://example.com", "Example")],
    closed: [{ url: "https://example.com", title: "Example", at: T }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "closed", "the one with a time survives");
});

test("browsing rows can be pinned and dismissed like any other", () => {
  const pinned = buildRows({
    launches: [{ text: "recent prompt", at: T }],
    sites: [site("https://example.com", "Example")],
    pinned: ["site:https://example.com"],
  });
  assert.equal(pinned[0].title, "Example");

  assert.equal(
    buildRows({ sites: [site("https://example.com", "Example")], dismissed: ["site:https://example.com"] }).length,
    0,
  );
});

test("browsing rows are searchable by title and by host", () => {
  const rows = buildRows({ sites: [site("https://news.example.com", "The Daily")] });
  assert.equal(filterRows(rows, "daily").length, 1);
  assert.equal(filterRows(rows, "news.example").length, 1);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(buildRows(), []);
  assert.deepEqual(buildRows({ visits: [], launches: [] }), []);
});

// --- filtering ---------------------------------------------------------------

const sample = buildRows({
  visits: [visit(UUID, "Evaluate Claude vs rivals", T), visit(OTHER, "News about air quality", T - 1)],
  launches: [{ text: "group github activity by repo", at: T - 900_000 }],
});

test("an empty query is not a filter", () => {
  assert.equal(filterRows(sample, "").length, 3);
  assert.equal(filterRows(sample, "   ").length, 3);
});

test("a substring match ranks first", () => {
  // Not *only* — "air" is also a subsequence of "group github activity by repo"
  // (**a**ctivity … **r**epo), which is what fuzzy matching is for. With six
  // rows at most, a weak match costs a line; ranking is what has to be right.
  assert.equal(filterRows(sample, "air")[0].title, "News about air quality");
});

test("matching ignores case", () => {
  assert.equal(filterRows(sample, "CLAUDE").length, 1);
});

test("a subsequence matches, command-palette style", () => {
  assert.deepEqual(filterRows(sample, "evcl").map((r) => r.title), ["Evaluate Claude vs rivals"]);
});

test("prompt rows are searchable by their own text", () => {
  assert.deepEqual(filterRows(sample, "github").map((r) => r.text), ["group github activity by repo"]);
});

test("a conversation is findable by the prompt that started it", () => {
  const rows = buildRows({
    visits: [visit(UUID, "Opaque title", T)],
    launches: [{ text: "sourdough starter ratios", at: T - 1000 }],
  });
  assert.equal(filterRows(rows, "sourdough").length, 1);
});

test("no match is an empty list, not everything", () => {
  assert.deepEqual(filterRows(sample, "zzzzq"), []);
});

test("contiguous matches outrank scattered ones", () => {
  const rows = buildRows({
    launches: [
      { text: "a b c l a u d e", at: T },
      { text: "claude", at: T - 1000 },
    ],
  });
  assert.equal(filterRows(rows, "claude")[0].text, "claude");
});

// --- multi-provider recall (the "recent chats aren't showing" fix) -----------

test("a conversation with a custom GPT is recognised", () => {
  // /g/g-xxxx/c/<uuid>. Matching only /c/<uuid> dropped every one of these.
  const rows = buildRows({
    visits: [{
      url: `https://chatgpt.com/g/g-p-abc123/c/${UUID}`,
      title: "Via a custom GPT",
      lastVisitTime: T,
    }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, `https://chatgpt.com/c/${UUID}`, "normalised to the canonical address");
});

test("the old chat.openai.com address still counts", () => {
  const rows = buildRows({
    visits: [{ url: `https://chat.openai.com/c/${UUID}`, title: "An older chat", lastVisitTime: T }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "ChatGPT");
});

test("Claude conversations are recognised too, and labelled", () => {
  const rows = buildRows({
    visits: [{ url: `https://claude.ai/chat/${UUID}`, title: "Fletching an arrow", lastVisitTime: T }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "Claude");
  assert.equal(rows[0].url, `https://claude.ai/chat/${UUID}`);
});

test("a chat.openai.com visit and its chatgpt.com twin collapse to one row", () => {
  const rows = buildRows({
    visits: [
      { url: `https://chat.openai.com/c/${UUID}`, title: "Same conversation", lastVisitTime: T },
      { url: `https://chatgpt.com/c/${UUID}`, title: "Same conversation", lastVisitTime: T + 1000 },
    ],
  });
  assert.equal(rows.length, 1);
});

test("look-alike hosts are still refused", () => {
  for (const url of [
    `https://chatgpt.com.evil.com/c/${UUID}`,
    `https://evil.com/chatgpt.com/c/${UUID}`,
    `https://claude.ai.evil.com/chat/${UUID}`,
    `http://chatgpt.com/c/${UUID}`,
    `https://notclaude.ai/chat/${UUID}`,
  ]) {
    assert.equal(conversationId(url), null, url);
  }
});

test("a tab that was never named is still a row, named for its assistant", () => {
  for (const [url, title, expected] of [
    [`https://chatgpt.com/c/${UUID}`, "ChatGPT", "ChatGPT conversation"],
    [`https://claude.ai/chat/${UUID}`, "Claude", "Claude conversation"],
    [`https://claude.ai/chat/${UUID}`, "Claude.ai", "Claude conversation"],
    [`https://chatgpt.com/c/${UUID}`, "New chat", "ChatGPT conversation"],
  ]) {
    const rows = buildRows({ visits: [{ url, title, lastVisitTime: T }] });
    assert.equal(rows.length, 1, `${title}`);
    assert.equal(rows[0].title, expected, `${title}`);
  }
});

test("a product-name suffix is stripped from the title", () => {
  const rows = buildRows({
    visits: [{ url: `https://claude.ai/chat/${UUID}`, title: "Fletching an arrow - Claude", lastVisitTime: T }],
  });
  assert.equal(rows[0].title, "Fletching an arrow");
});

test("a blank or non-string launch never becomes a row or a title", () => {
  // The launch log is user text from storage, and it is now a row *title* — so
  // a whitespace-only entry would render as a blank row, and unboundPrompts
  // lowercases whatever it finds.
  const rows = buildRows({
    visits: [],
    launches: [{ text: "   ", at: T }, { text: null, at: T }, { at: T }, { text: 42, at: T }],
  });
  assert.equal(rows.length, 0, JSON.stringify(rows));
});

test("a launch is trimmed before it names a conversation", () => {
  const rows = buildRows({
    visits: [{ url: `https://chatgpt.com/c/${UUID}`, title: "ChatGPT", lastVisitTime: T, firstVisitTime: T }],
    launches: [{ text: "  how do I fletch an arrow  ", at: T - 1000 }],
  });
  assert.equal(rows[0].title, "how do I fletch an arrow");
});
