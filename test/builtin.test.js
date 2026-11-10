import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AVAILABLE,
  DOWNLOADABLE,
  DOWNLOADING,
  UNAVAILABLE,
  MODEL_OPTIONS,
  isUsable,
  needsDownload,
  chooseEngine,
  builtinAvailability,
  nextDelta,
  percent,
  describeBuiltinFailure,
  streamBuiltin,
} from "../extension/src/builtin.js";

test("available and downloadable are both usable; unavailable is not", () => {
  assert.equal(isUsable(AVAILABLE), true);
  assert.equal(isUsable(DOWNLOADABLE), true);
  assert.equal(isUsable(DOWNLOADING), true);
  assert.equal(isUsable(UNAVAILABLE), false);
  assert.equal(isUsable(undefined), false);
  assert.equal(needsDownload(AVAILABLE), false);
  assert.equal(needsDownload(DOWNLOADABLE), true);
});

test("a key with a model wins over the built-in model", () => {
  assert.equal(chooseEngine({ apiKey: "sk-x", model: "gpt-6-luna", builtin: AVAILABLE }), "openai");
});

test("with no key the built-in model answers, if Chrome has one", () => {
  assert.equal(chooseEngine({ apiKey: "", model: "", builtin: AVAILABLE }), "builtin");
  assert.equal(chooseEngine({ apiKey: "", model: "", builtin: DOWNLOADABLE }), "builtin");
  // A key whose model was never picked cannot answer, so it does not block the free engine.
  assert.equal(chooseEngine({ apiKey: "sk-x", model: "", builtin: AVAILABLE }), "builtin");
});

test("with neither, nothing answers", () => {
  assert.equal(chooseEngine({ apiKey: "", model: "", builtin: UNAVAILABLE }), null);
});

test("builtinAvailability is unavailable when the API does not exist", async () => {
  assert.equal(await builtinAvailability(undefined), UNAVAILABLE);
  assert.equal(await builtinAvailability({}), UNAVAILABLE);
});

test("builtinAvailability passes the language options and returns the state", async () => {
  let seen;
  const api = { availability: async (options) => ((seen = options), DOWNLOADABLE) };
  assert.equal(await builtinAvailability(api), DOWNLOADABLE);
  assert.deepEqual(seen, MODEL_OPTIONS);
});

test("builtinAvailability survives a throw, a hang and a state it does not know", async () => {
  assert.equal(await builtinAvailability({ availability: async () => { throw new Error("x"); } }), UNAVAILABLE);
  assert.equal(await builtinAvailability({ availability: () => new Promise(() => {}) }, 10), UNAVAILABLE);
  assert.equal(await builtinAvailability({ availability: async () => "readily" }), UNAVAILABLE);
});

test("nextDelta reads both delta and cumulative streams", () => {
  assert.equal(nextDelta("", "Hello"), "Hello");
  assert.equal(nextDelta("Hello", " world"), " world");
  assert.equal(nextDelta("Hello", "Hello world"), " world");
  assert.equal(nextDelta("Hello", "Hello"), "Hello");
});

test("percent clamps and rounds download progress", () => {
  assert.equal(percent(0.456), 46);
  assert.equal(percent(2), 100);
  assert.equal(percent(undefined), 0);
});

test("every failure has words, and a long prompt says to shorten it", () => {
  const named = (name) => Object.assign(new Error("x"), { name });
  assert.match(describeBuiltinFailure(named("QuotaExceededError")), /Shorten it/);
  assert.match(describeBuiltinFailure(named("NetworkError")), /connection/);
  assert.match(describeBuiltinFailure(new Error("weird")), /couldn't answer/);
  assert.match(describeBuiltinFailure(undefined), /couldn't answer/);
});

function fakeApi(chunks, { progress = [] } = {}) {
  const calls = { destroyed: 0, created: null };
  return {
    calls,
    async create(options) {
      calls.created = options;
      const target = new EventTarget();
      options.monitor?.(target);
      for (const loaded of progress) target.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded }));
      return {
        promptStreaming() {
          return (async function* () {
            yield* chunks;
          })();
        },
        destroy() {
          calls.destroyed++;
        },
      };
    },
  };
}

test("streamBuiltin streams deltas, reports download progress and frees the session", async () => {
  const api = fakeApi(["Arrows ", "fly."], { progress: [0, 0.5, 1] });
  const seen = [];
  const progress = [];
  const { text } = await streamBuiltin({ prompt: "p", api, onText: (d) => seen.push(d), onProgress: (l) => progress.push(l) });
  assert.equal(text, "Arrows fly.");
  assert.deepEqual(seen, ["Arrows ", "fly."]);
  assert.deepEqual(progress, [0, 0.5, 1]);
  assert.equal(api.calls.destroyed, 1);
  assert.deepEqual(api.calls.created.expectedInputs, MODEL_OPTIONS.expectedInputs);
});

test("streamBuiltin frees the session when the stream fails", async () => {
  const api = fakeApi([]);
  const broken = {
    async create(options) {
      const session = await api.create(options);
      session.promptStreaming = () => {
        throw Object.assign(new Error("too long"), { name: "QuotaExceededError" });
      };
      return session;
    },
  };
  await assert.rejects(streamBuiltin({ prompt: "p", api: broken }), { name: "QuotaExceededError" });
  assert.equal(api.calls.destroyed, 1);
});

test("streamBuiltin refuses cleanly when there is no API", async () => {
  await assert.rejects(streamBuiltin({ prompt: "p", api: undefined }), { name: "NotSupportedError" });
});
