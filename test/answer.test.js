import { test } from "node:test";
import assert from "node:assert/strict";
import { splitEvents, parseFrame, estimateCost, checkCap } from "../extension/src/answer.js";
import { route, ANSWER, SEARCH, NAVIGATE, ANSWER_MODE } from "../extension/src/router.js";
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

test("answer mode with no key degrades to a search rather than failing", () => {
  const verdict = route("what is a nock", { mode: ANSWER_MODE, canAnswer: false });
  assert.equal(verdict.action, SEARCH);
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
