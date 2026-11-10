import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitEvents,
  parseFrame,
  estimateCost,
  checkCap,
  isChatModel,
  pickModel,
  keyProblem,
  explainFailure,
  streamAnswer,
  listModels,
  checkKey,
  OFFLINE,
  PREFERRED_MODELS,
} from "../extension/src/answer.js";
import { route, ANSWER, ASK, NAVIGATE, ANSWER_MODE } from "../extension/src/router.js";
import { dayStamp } from "../extension/src/settings.js";

// --- SSE framing -------------------------------------------------------------

test("complete events come out, the partial one stays behind", () => {
  const { events, rest } = splitEvents("data: {}\n\ndata: {}\n\ndata: {\"half\"");
  assert.equal(events.length, 2);
  assert.equal(rest, 'data: {"half"');
});

test("a buffer with nothing complete yields nothing and keeps everything", () => {
  const { events, rest } = splitEvents("data: {\"par");
  assert.deepEqual(events, []);
  assert.equal(rest, 'data: {"par');
});

test("a stream reassembles across arbitrary chunk boundaries", () => {
  // The network splits wherever it likes, including mid-token. Feed the same
  // stream one byte at a time and the text must come out whole.
  const stream =
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":", world"}}]}\n\n' +
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}\n\n' +
    "data: [DONE]\n\n";

  let buffer = "";
  let text = "";
  let usage = null;

  for (const ch of stream) {
    buffer += ch;
    const { events, rest } = splitEvents(buffer);
    buffer = rest;
    for (const event of events) {
      const frame = parseFrame(event);
      if (frame?.text) text += frame.text;
      if (frame?.usage) usage = frame.usage;
    }
  }

  assert.equal(text, "Hello, world");
  assert.deepEqual(usage, { prompt: 9, completion: 3, total: 12 });
});

// --- frame parsing -----------------------------------------------------------

test("[DONE] is not content", () => {
  assert.equal(parseFrame("data: [DONE]"), null);
});

test("a comment or keep-alive line is ignored", () => {
  assert.equal(parseFrame(": keep-alive"), null);
  assert.equal(parseFrame(""), null);
});

test("a malformed frame is skipped rather than fatal", () => {
  assert.equal(parseFrame("data: {not json"), null);
});

test("an empty delta produces nothing", () => {
  assert.equal(parseFrame('data: {"choices":[{"delta":{"content":""}}]}'), null);
});

test("a non-string delta is not treated as text", () => {
  assert.equal(parseFrame('data: {"choices":[{"delta":{"content":{"nested":1}}}]}'), null);
});

test("usage with no delta still comes through", () => {
  assert.deepEqual(parseFrame('data: {"choices":[],"usage":{"total_tokens":5}}'), {
    usage: { prompt: 0, completion: 0, total: 5 },
  });
});

// --- budget ------------------------------------------------------------------

test("no rates means no dollar figure, rather than a made-up one", () => {
  assert.equal(estimateCost({ prompt: 1000, completion: 1000 }), null);
  assert.equal(estimateCost({ prompt: 1000, completion: 1000 }, { inputPerM: 0, outputPerM: 0 }), null);
});

test("a cost is computed from the user's own rates", () => {
  const cost = estimateCost({ prompt: 1_000_000, completion: 500_000 }, { inputPerM: 2, outputPerM: 8 });
  assert.equal(cost, 2 + 4);
});

test("one rate is enough", () => {
  assert.equal(estimateCost({ prompt: 1_000_000, completion: 999 }, { inputPerM: 3 }), 3);
});

test("a cap of zero is no cap", () => {
  assert.equal(checkCap(999_999, 0).allowed, true);
});

test("the cap blocks once it is reached, not after it is exceeded", () => {
  assert.equal(checkCap(999, 1000).allowed, true);
  assert.equal(checkCap(1000, 1000).allowed, false);
  assert.equal(checkCap(1001, 1000).allowed, false);
});

test("the day stamp is a local calendar day", () => {
  assert.equal(dayStamp(new Date(2026, 7, 7, 23, 59)), "2026-08-07");
  assert.equal(dayStamp(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
});

// --- routing into and out of answer mode -------------------------------------

test("answer mode answers a prompt on the page", () => {
  const verdict = route("what is a nock", { mode: ANSWER_MODE, canAnswer: true });
  assert.equal(verdict.action, ANSWER);
  assert.equal(verdict.text, "what is a nock");
});

test("answer mode still opens a URL as a URL", () => {
  assert.equal(route("example.com", { mode: ANSWER_MODE, canAnswer: true }).action, NAVIGATE);
});

test("answer mode with nothing to answer hands off rather than searching silently", () => {
  const verdict = route("what is a nock", { mode: ANSWER_MODE, canAnswer: false });
  assert.equal(verdict.action, ASK);
  assert.equal(verdict.text, "what is a nock");
});

test("...and a URL in that state still navigates", () => {
  assert.equal(route("example.com", { mode: ANSWER_MODE, canAnswer: false }).action, NAVIGATE);
});

test("a key does not make javascript: navigable", () => {
  const verdict = route("javascript:alert(1)", { mode: ANSWER_MODE, canAnswer: true });
  assert.equal(verdict.action, ANSWER);
  assert.equal(verdict.url, undefined);
});

// --- choosing a model, so a saved key needs nothing else (QA P1-2) ----------------

// Roughly what /v1/models returns for a new Platform account.
const LISTED = [
  "babbage-002", "chatgpt-4o-latest", "codex-mini-latest", "dall-e-2", "dall-e-3", "davinci-002",
  "gpt-3.5-turbo-instruct", "gpt-4o-audio-preview", "gpt-4o-mini", "gpt-4o-mini-2024-07-18",
  "gpt-4o-mini-search-preview", "gpt-4o-mini-transcribe", "gpt-4o-mini-tts", "gpt-4o-realtime-preview",
  "gpt-5-codex", "gpt-5-pro", "gpt-5.4-mini", "gpt-6-luna", "gpt-image-1", "o4-mini-deep-research",
  "omni-moderation-latest", "text-embedding-3-small", "tts-1", "whisper-1",
];

test("isChatModel keeps chat models and drops images, speech, search and the rest", () => {
  assert.deepEqual(LISTED.filter(isChatModel), [
    "chatgpt-4o-latest", "gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-5.4-mini", "gpt-6-luna",
  ]);
});

test("pickModel takes the first preferred model the key can reach", () => {
  assert.equal(pickModel(LISTED), "gpt-6-luna");
  assert.equal(pickModel(["gpt-4o-mini", "gpt-5-mini"]), "gpt-5-mini");
});

test("pickModel falls back to a dated snapshot of a preferred model", () => {
  assert.equal(pickModel(["gpt-4o-mini-2024-07-18", "dall-e-3"]), "gpt-4o-mini-2024-07-18");
});

test("pickModel is null when the key reaches no preferred model", () => {
  assert.equal(pickModel(["dall-e-3", "whisper-1"]), null);
  assert.equal(pickModel([]), null);
});

test("every preferred model is itself a chat model", () => {
  for (const id of PREFERRED_MODELS) assert.ok(isChatModel(id), id);
});

test("keyProblem catches what is plainly not a key, before any request", () => {
  assert.match(keyProblem(""), /Paste a key/);
  assert.match(keyProblem("hello there"), /spaces/);
  assert.match(keyProblem("pk-abcdefghijklmnopqrstuvwxyz"), /start with “sk-”/);
  assert.match(keyProblem("sk-short"), /cut short/);
  assert.equal(keyProblem("  sk-proj-abcdefghijklmnopqrstuvwxyz  "), null);
});

// --- failures in plain words (QA §3.2, P2-7) --------------------------------------

test("a rejected key says where to get a good one", () => {
  const text = explainFailure(401, { error: { message: "Incorrect API key provided: sk-...", code: "invalid_api_key" } });
  assert.match(text, /didn't accept that key/);
  assert.match(text, /platform\.openai\.com\/api-keys/);
  assert.doesNotMatch(text, /sk-/);
});

test("no credit is named as no credit, with where to add it and the free way out", () => {
  const text = explainFailure(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } });
  assert.equal(
    text,
    "Your OpenAI account has no credit yet. Add $5+ at platform.openai.com/settings/organization/billing — or keep using ChatGPT hand-off for free.",
  );
});

test("a plain rate limit is not mistaken for no credit", () => {
  assert.match(explainFailure(429, { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }), /rate-limiting/);
  assert.match(explainFailure(429, null), /rate-limiting/);
});

test("a model the key cannot use points at the Model setting", () => {
  assert.match(explainFailure(404, { error: { code: "model_not_found" } }), /Settings → Model/);
});

test("server trouble and unknown statuses still say something useful", () => {
  assert.match(explainFailure(503, null), /OpenAI is having trouble right now \(503\)/);
  assert.equal(explainFailure(400, { error: { message: "Bad thing" } }), "Bad thing");
  assert.equal(explainFailure(418, "not json"), "OpenAI returned an error (418).");
});

async function withFetch(fake, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("a network failure reads as one, not as \"Failed to fetch\"", async () => {
  const fail = async () => {
    throw new TypeError("Failed to fetch");
  };
  await withFetch(fail, async () => {
    await assert.rejects(streamAnswer({ key: "k", model: "m", prompt: "p" }), { message: OFFLINE });
    await assert.rejects(listModels("k"), { message: OFFLINE });
  });
  assert.equal(OFFLINE, "Couldn't reach OpenAI — check your connection.");
});

test("an abort is passed through, not reported as a network failure", async () => {
  const abort = async () => {
    throw new DOMException("The user aborted a request.", "AbortError");
  };
  await withFetch(abort, () => assert.rejects(streamAnswer({ key: "k", model: "m", prompt: "p" }), { name: "AbortError" }));
});

test("checkKey lists only chat models and picks one", async () => {
  const fake = async () => new Response(JSON.stringify({ data: LISTED.map((id) => ({ id })) }), { status: 200 });
  const { models, model } = await withFetch(fake, () => checkKey("sk-test"));
  assert.ok(!models.includes("dall-e-3"));
  assert.equal(model, "gpt-6-luna");
});

test("checkKey throws the explained failure for a bad key", async () => {
  const fake = async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 });
  await withFetch(fake, () => assert.rejects(checkKey("sk-bad"), /didn't accept that key/));
});
