// Answers from Chrome's built-in model (the Prompt API, `LanguageModel`), on
// this device. Free, keyless, and it makes no network request of its own —
// Chrome downloads the model once, to its own profile, and then everything
// runs locally. Extensions get the API in Chrome 138+ with no permission.
//
// Hardware decides whether it exists at all (roughly: 22 GB of free disk and a
// capable GPU, or 16 GB of RAM), so every caller has to cope with "no".
// Nothing here throws for want of the API; availability() says "unavailable".
//
// The decisions — which engine answers, how to read a stream chunk, what a
// failure means — are pure functions below, testable without Chrome.

export const AVAILABLE = "available";
export const DOWNLOADABLE = "downloadable";
export const DOWNLOADING = "downloading";
export const UNAVAILABLE = "unavailable";

const STATES = [AVAILABLE, DOWNLOADABLE, DOWNLOADING, UNAVAILABLE];

/**
 * Passed identically to availability(), create() and so to every prompt, as
 * Chrome asks: the model's answer to "can you do this" depends on languages.
 */
export const MODEL_OPTIONS = Object.freeze({
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
});

/** Whether the built-in model can be used, now or after a download. */
export const isUsable = (state) => state === AVAILABLE || state === DOWNLOADABLE || state === DOWNLOADING;

/** Whether using it now means waiting for a download first. */
export const needsDownload = (state) => state === DOWNLOADABLE || state === DOWNLOADING;

/**
 * Which engine answers on the page. A key the user went to the trouble of
 * setting up wins — it is the bigger model and it can see images.
 *
 * @returns {"openai"|"builtin"|null}
 */
export function chooseEngine({ apiKey, model, builtin }) {
  if (apiKey && model) return "openai";
  if (isUsable(builtin)) return "builtin";
  return null;
}

/**
 * The model's state, never throwing. Some builds have shipped an API that
 * hangs rather than answer on unsupported hardware, so this gives up after
 * `timeoutMs` and says unavailable.
 */
export async function builtinAvailability(api = globalThis.LanguageModel, timeoutMs = 3000) {
  if (typeof api?.availability !== "function") return UNAVAILABLE;
  let timer;
  try {
    const state = await Promise.race([
      api.availability(MODEL_OPTIONS),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(UNAVAILABLE), timeoutMs);
      }),
    ]);
    return STATES.includes(state) ? state : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The new text in a streamed chunk. Chrome streams deltas; early builds
 * streamed the whole answer so far each time. Reading both keeps an answer
 * from doubling itself on either.
 */
export function nextDelta(sofar, chunk) {
  const text = String(chunk ?? "");
  if (sofar && text.length > sofar.length && text.startsWith(sofar)) return text.slice(sofar.length);
  return text;
}

/** Download progress as a whole percentage, from the event's 0–1 `loaded`. */
export const percent = (loaded) => Math.max(0, Math.min(100, Math.round((Number(loaded) || 0) * 100)));

/** A built-in model failure, in words. */
export function describeBuiltinFailure(error) {
  switch (error?.name) {
    case "QuotaExceededError":
      return "That's more than Chrome's built-in model can read at once. Shorten it, or send it to a hand-off instead.";
    case "NotSupportedError":
      return "Chrome's built-in model can't answer that — it reads English text only.";
    case "NotAllowedError":
      return "Chrome didn't allow its built-in model here. Click in the box and try again.";
    case "InvalidStateError":
    case "OperationError":
      return "Chrome's built-in model stopped. Try again, or send it to a hand-off instead.";
    case "NetworkError":
      return "Chrome couldn't download its built-in model — check your connection and try again.";
    default:
      return "Chrome's built-in model couldn't answer this time. Try again, or send it to a hand-off instead.";
  }
}

/**
 * A session with the model, downloading it first if it has to be. The
 * download is Chrome's, to Chrome's own storage; it needs a user gesture, so
 * call this from the click or keypress that asked for it.
 *
 * @param {{signal?: AbortSignal, onProgress?: (loaded: number) => void, api?: any}} [options]
 */
export async function openSession({ signal, onProgress, api = globalThis.LanguageModel } = {}) {
  if (typeof api?.create !== "function") {
    const error = new Error("Chrome's built-in model isn't available in this browser.");
    error.name = "NotSupportedError";
    throw error;
  }
  return api.create({
    ...MODEL_OPTIONS,
    signal,
    monitor(m) {
      m.addEventListener("downloadprogress", (event) => onProgress?.(event.loaded));
    },
  });
}

/**
 * Streams one answer from the built-in model.
 *
 * @param {{prompt: string, signal?: AbortSignal, onText: (delta: string) => void,
 *          onProgress?: (loaded: number) => void, api?: any}} request
 * @returns {Promise<{text: string}>}
 */
export async function streamBuiltin({ prompt, signal, onText, onProgress, api }) {
  const session = await openSession({ signal, onProgress, api });
  try {
    let text = "";
    for await (const chunk of session.promptStreaming(prompt, { signal })) {
      const delta = nextDelta(text, chunk);
      if (!delta) continue;
      text += delta;
      onText?.(delta);
    }
    return { text };
  } finally {
    session.destroy?.();
  }
}
