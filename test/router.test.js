import { test } from "node:test";
import assert from "node:assert/strict";
import { URL_KIND, PROMPT } from "../extension/src/classify.js";
import {
  route,
  NONE,
  NAVIGATE,
  SEARCH,
  ASK,
  AUTO,
  GOOGLE,
  CHATGPT,
  SEARCH_MODE,
  ANSWER,
  ANSWER_MODE,
  CLAUDE,
  PERPLEXITY,
  placeholderFor,
  handoffURL,
  targetName,
  fallbackFor,
} from "../extension/src/router.js";

// [input, mode, force, expected action, expected url or text]
const CASES = [
  // --- nothing to do, in every mode ---
  ["", AUTO, null, NONE],
  ["   ", CHATGPT, null, NONE],
  ["", SEARCH_MODE, null, NONE],

  // --- Auto: the classifier decides, prompts go to the default engine ---
  ["example.com", AUTO, null, NAVIGATE, "https://example.com"],
  ["localhost:3000", AUTO, null, NAVIGATE, "http://localhost:3000"],
  ["what is a nock", AUTO, null, SEARCH, "what is a nock"],
  ["node.js", AUTO, null, SEARCH, "node.js"],

  // --- ChatGPT: URLs still open; prompts go to ChatGPT regardless of engine ---
  ["example.com", CHATGPT, null, NAVIGATE, "https://example.com"],
  ["what is a nock", CHATGPT, null, ASK, "https://chatgpt.com/?q=what%20is%20a%20nock"],
  ["a&b=c #d", CHATGPT, null, ASK, "https://chatgpt.com/?q=a%26b%3Dc%20%23d"],

  // --- Search: never navigates, even for something that parses as a URL ---
  ["example.com", SEARCH_MODE, null, SEARCH, "example.com"],
  ["https://example.com", SEARCH_MODE, null, SEARCH, "https://example.com"],
  ["localhost:3000", SEARCH_MODE, null, SEARCH, "localhost:3000"],
  ["what is a nock", SEARCH_MODE, null, SEARCH, "what is a nock"],

  // --- a modifier is more recent intent than a mode, so it wins ---
  ["example.com", AUTO, PROMPT, SEARCH, "example.com"],
  ["intranet", AUTO, URL_KIND, NAVIGATE, "https://intranet"],
  ["example.com", SEARCH_MODE, URL_KIND, NAVIGATE, "https://example.com"],
  ["example.com", CHATGPT, PROMPT, ASK, "https://chatgpt.com/?q=example.com"],
  ["intranet", CHATGPT, URL_KIND, NAVIGATE, "https://intranet"],

  // --- the privileged-origin rule holds in every mode ---
  ["javascript:alert(1)", AUTO, null, SEARCH, "javascript:alert(1)"],
  ["javascript:alert(1)", SEARCH_MODE, null, SEARCH, "javascript:alert(1)"],
  ["javascript:alert(1)", CHATGPT, null, ASK, "https://chatgpt.com/?q=javascript%3Aalert(1)"],
  ["data:text/html,<script>", AUTO, null, SEARCH, "data:text/html,<script>"],
  ["file:///etc/passwd", AUTO, null, SEARCH, "file:///etc/passwd"],
  ["google.com@evil.com", AUTO, null, SEARCH, "google.com@evil.com"],
];

for (const [input, mode, force, action, expected] of CASES) {
  test(`route(${JSON.stringify(input)}, ${mode}${force ? `, force:${force}` : ""}) → ${action}`, () => {
    const verdict = route(input, { mode, force });
    assert.equal(verdict.action, action);

    if (action === NAVIGATE || action === ASK) assert.equal(verdict.url, expected);
    if (action === SEARCH) assert.equal(verdict.text, expected);
  });
}

test("an unknown mode routes like Auto rather than failing closed", () => {
  assert.deepEqual(route("example.com", { mode: "nonsense" }), {
    action: NAVIGATE,
    url: "https://example.com",
  });
});

test("Auto is the default when no mode is given", () => {
  assert.equal(route("what is a nock").action, SEARCH);
});

test("an ASK verdict carries the raw prompt for the launch log", () => {
  assert.equal(route("what is a nock", { mode: CHATGPT }).text, "what is a nock");
});

test("no verdict can ever produce a non-http(s) url", () => {
  const hostile = [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "chrome://settings",
    "vbscript:msgbox(1)",
  ];
  for (const raw of hostile) {
    for (const mode of [AUTO, CHATGPT, SEARCH_MODE]) {
      for (const force of [null, PROMPT, URL_KIND]) {
        const verdict = route(raw, { mode, force });
        if (verdict.url) assert.match(verdict.url, /^https?:\/\//i, `${raw} @ ${mode} force:${force}`);
      }
    }
  }
});

// --- Google is a destination, not the default engine -------------------------------
//
// These exist because of a bug worth not repeating: the pill labelled "Search"
// was `data-mode="auto"`, and Auto hands prompts to chrome.search — the user's
// *default* engine. For anyone who had made ChatGPT their default (which the
// page's own hint suggests), pressing "Search" sent them to ChatGPT. A pill
// naming a place has to go to that place.

test("Google mode sends a prompt to Google, whatever the default engine is", () => {
  const verdict = route("submit an extension to the chrome store", { mode: GOOGLE });
  assert.equal(verdict.action, ASK);
  assert.equal(
    verdict.url,
    "https://www.google.com/search?q=submit%20an%20extension%20to%20the%20chrome%20store",
  );
});

test("Google mode still navigates a URL, like every other destination", () => {
  assert.deepEqual(route("example.com", { mode: GOOGLE }), {
    action: NAVIGATE,
    url: "https://example.com",
  });
});

test("Auto and Search still defer to the default engine", () => {
  assert.equal(route("a question", { mode: AUTO }).action, SEARCH);
  assert.equal(route("a question", { mode: SEARCH_MODE }).action, SEARCH);
});

test("the placeholder names Google when Google is the destination", () => {
  assert.equal(placeholderFor(GOOGLE), "Search Google, or type a URL");
  assert.notEqual(placeholderFor(GOOGLE), placeholderFor(AUTO));
});

test("Google mode cannot be talked into a non-http(s) url either", () => {
  for (const raw of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
    for (const force of [null, PROMPT, URL_KIND]) {
      const verdict = route(raw, { mode: GOOGLE, force });
      if (verdict.url) assert.match(verdict.url, /^https?:\/\//i, `${raw} force:${force}`);
    }
  }
});

// --- answer mode with nothing to answer (QA P2-2) ---------------------------------
//
// It used to become Auto, so the question went to the default engine with no
// word said. It now goes to the hand-off the user chose, and the page says so.

test("answer mode answers on the page when something can answer", () => {
  assert.deepEqual(route("what is a nock", { mode: ANSWER_MODE, canAnswer: true }), {
    action: ANSWER,
    text: "what is a nock",
  });
});

test("answer mode with nothing to answer hands off to ChatGPT by default", () => {
  const verdict = route("what is a nock", { mode: ANSWER_MODE, canAnswer: false });
  assert.equal(verdict.action, ASK);
  assert.equal(verdict.url, "https://chatgpt.com/?q=what%20is%20a%20nock");
});

test("answer mode falls back to the hand-off the user picked", () => {
  assert.equal(route("q", { mode: ANSWER_MODE, fallback: CLAUDE }).url, "https://claude.ai/new?q=q");
  assert.equal(route("q", { mode: ANSWER_MODE, fallback: PERPLEXITY }).url, "https://www.perplexity.ai/search?q=q");
});

test("answer mode never falls back to a silent search, whatever the setting says", () => {
  for (const fallback of [AUTO, SEARCH_MODE, ANSWER_MODE, "nonsense", undefined]) {
    assert.equal(route("q", { mode: ANSWER_MODE, fallback }).action, ASK, String(fallback));
  }
});

test("answer mode with nothing to answer still navigates a URL", () => {
  assert.equal(route("example.com:8080", { mode: ANSWER_MODE }).url, "https://example.com:8080");
});

test("the placeholder names the fallback when answer mode cannot answer", () => {
  assert.equal(placeholderFor(ANSWER_MODE, false), "Ask ChatGPT, or type a URL");
  assert.equal(placeholderFor(ANSWER_MODE, false, CLAUDE), "Ask Claude, or type a URL");
  assert.equal(placeholderFor(ANSWER_MODE, true), "Ask, and the answer appears here");
});

test("fallbackFor only accepts a hand-off", () => {
  assert.equal(fallbackFor(CLAUDE), CLAUDE);
  assert.equal(fallbackFor(AUTO), CHATGPT);
  assert.equal(fallbackFor(GOOGLE), GOOGLE);
});

test("handoffURL builds the same link route() does, and refuses other modes", () => {
  assert.equal(handoffURL(CHATGPT, "  a b "), "https://chatgpt.com/?q=a%20b");
  assert.equal(handoffURL(AUTO, "a"), null);
  assert.equal(handoffURL(ANSWER_MODE, "a"), null);
});

test("targetName names each destination", () => {
  assert.equal(targetName(CHATGPT), "ChatGPT");
  assert.equal(targetName(CLAUDE), "Claude");
  assert.equal(targetName(PERPLEXITY), "Perplexity");
  assert.equal(targetName(AUTO), "your search engine");
});
