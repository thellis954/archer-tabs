// Streams an answer from the user's own OpenAI Platform key, straight from this
// page to api.openai.com.
//
// **The key never leaves the device except to OpenAI.** There is no server in
// this project, nothing is proxied, and nothing is logged anywhere but
// chrome.storage.local. That is the whole reason bring-your-own-key is the only
// form of this feature worth building (docs/ROADMAP.md §3.4).
//
// The SSE parsing and the accounting are separated out as pure functions below
// so they can be tested without a network.

const ENDPOINT = "https://api.openai.com/v1";

/** The host permission this needs. Optional, and requested when a key is saved. */
export const API_ORIGIN = "https://api.openai.com/*";

/** What every failure to reach api.openai.com says, instead of "Failed to fetch". */
export const OFFLINE = "Couldn't reach OpenAI — check your connection.";

/**
 * The models Archer picks from on its own, cheapest-capable first. A key that
 * can reach none of them still works — the Model card lists every chat model
 * it can — but nobody should have to know a model name to get an answer.
 */
export const PREFERRED_MODELS = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"];

// Everything /v1/models lists that cannot hold a chat: images, speech, search,
// embeddings, the realtime and agent models, and the legacy completions ones.
const NOT_CHAT =
  /(^|[-.])(dall-e|image|audio|realtime|tts|transcribe|whisper|embedding|moderation|search|codex|computer-use|live|pro|deep-research|instruct|babbage|davinci|sora|cyber|rosalind)([-.]|$)/i;

export const isChatModel = (id) =>
  typeof id === "string" && /^(gpt-|o\d|chatgpt-)/i.test(id) && !NOT_CHAT.test(id);

/**
 * The model to use when the user has not chosen one: the first of
 * {@link PREFERRED_MODELS} this key can reach, exact id first, then a dated
 * snapshot of it ("gpt-4o-mini-2024-07-18"). Null when none is reachable.
 */
export function pickModel(ids) {
  const have = new Set(ids);
  for (const want of PREFERRED_MODELS) if (have.has(want)) return want;
  for (const want of PREFERRED_MODELS) {
    const snapshot = [...have].filter((id) => id.startsWith(want + "-") && /-\d{4}-\d{2}-\d{2}$/.test(id)).sort().at(-1);
    if (snapshot) return snapshot;
  }
  return null;
}

/** Why a pasted string cannot be a key, before spending a request finding out. */
export function keyProblem(key) {
  const value = String(key ?? "").trim();
  if (!value) return "Paste a key first.";
  if (/\s/.test(value)) return "That has spaces in it — copy the key again, on its own.";
  if (!value.startsWith("sk-")) return "That doesn't look like an OpenAI API key — they start with “sk-”.";
  if (value.length < 20) return "That key looks cut short — copy it again.";
  return null;
}

/**
 * OpenAI's failure, in words someone without a Platform account can act on.
 * Pure, so every message is tested; the API's own text is kept only where it
 * is the most specific thing there is to say.
 *
 * @param {number} status
 * @param {any} body  the parsed error body, if it was JSON
 */
export function explainFailure(status, body) {
  const error = body?.error ?? {};
  const detail = typeof error.message === "string" ? error.message : "";
  const code = error.code ?? error.type ?? "";

  if (status === 401) {
    return "OpenAI didn't accept that key. Copy it again from platform.openai.com/api-keys — or keep using ChatGPT hand-off for free.";
  }
  if (status === 429 && /insufficient_quota|billing/i.test(`${code} ${detail}`)) {
    return "Your OpenAI account has no credit yet. Add $5+ at platform.openai.com/settings/organization/billing — or keep using ChatGPT hand-off for free.";
  }
  if (status === 429) return "OpenAI is rate-limiting this key. Wait a moment and try again.";
  if (status === 404 || code === "model_not_found") {
    return "This key can't use that model. Pick another under Settings → Model.";
  }
  if (status === 403) return detail || "OpenAI refused this request for this key's project.";
  if (status >= 500) return `OpenAI is having trouble right now (${status}). Try again in a moment.`;
  return detail || `OpenAI returned an error (${status}).`;
}

/** A fetch that fails for want of a network says so, in words. Aborts pass through. */
async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw offline(error);
  }
}

function offline(error) {
  return error?.name === "AbortError" ? error : new Error(OFFLINE, { cause: error });
}

export class SpendCapReached extends Error {
  constructor(used, cap) {
    super(`This session has used ${used} of its ${cap} token budget.`);
    this.name = "SpendCapReached";
  }
}

/**
 * A plain string when there is nothing but text, and the parts array only when
 * there is an image.
 *
 * The distinction matters: the parts form is what the vision models want, and
 * some older text-only models reject it outright. Sending the simple shape
 * whenever it is sufficient keeps every model that ever worked still working.
 */
export function contentFor(prompt, images = []) {
  if (!images.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

/**
 * @param {object} request
 * @param {string} request.key
 * @param {string} request.model
 * @param {string} request.prompt
 * @param {string[]} [request.images]  data: URLs, sent alongside the prompt
 * @param {AbortSignal} [request.signal]
 * @param {(chunk: string) => void} request.onText  called with each delta
 * @returns {Promise<{text: string, usage: {prompt: number, completion: number, total: number}}>}
 */
export async function streamAnswer({ key, model, prompt, images = [], signal, onText }) {
  const response = await request(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      // Without this the final usage frame is omitted and the token counter has
      // nothing exact to report.
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: contentFor(prompt, images) }],
    }),
  });

  if (!response.ok) throw new Error(await describeFailure(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = { prompt: 0, completion: 0, total: 0 };

  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw offline(error);
    }
    const { value, done } = chunk;
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = splitEvents(buffer);
    buffer = rest;

    for (const event of events) {
      const frame = parseFrame(event);
      if (!frame) continue;
      if (frame.text) {
        text += frame.text;
        onText?.(frame.text);
      }
      if (frame.usage) usage = frame.usage;
    }
  }

  return { text, usage };
}

/** Lists the chat models this key can actually reach, in name order. */
export async function listModels(key, signal) {
  const response = await request(`${ENDPOINT}/models`, {
    signal,
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(await describeFailure(response));

  const body = await response.json();
  return (body.data ?? [])
    .map((m) => m.id)
    .filter(isChatModel)
    .sort();
}

/**
 * Checks a key against /v1/models and chooses a model for it, so a saved key
 * answers with no further settings. Throws the explained failure.
 *
 * @returns {Promise<{models: string[], model: string|null}>}
 */
export async function checkKey(key, signal) {
  const models = await listModels(key, signal);
  return { models, model: pickModel(models) };
}

async function describeFailure(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* not JSON */
  }
  return explainFailure(response.status, body);
}

// --- pure parts, so they can be tested without a network ---------------------

/**
 * Splits an SSE buffer into complete events, keeping whatever is left over.
 * A chunk boundary can fall anywhere, including mid-token, so the remainder
 * has to survive to the next read.
 */
export function splitEvents(buffer) {
  const parts = buffer.split("\n\n");
  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

/** @returns {{text?: string, usage?: object}|null} */
export function parseFrame(event) {
  const line = event
    .split("\n")
    .find((l) => l.startsWith("data:"));
  if (!line) return null;

  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;

  let frame;
  try {
    frame = JSON.parse(payload);
  } catch {
    return null; // a truncated or non-JSON frame is skipped, not fatal
  }

  const out = {};
  const delta = frame.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta) out.text = delta;

  if (frame.usage) {
    out.usage = {
      prompt: frame.usage.prompt_tokens ?? 0,
      completion: frame.usage.completion_tokens ?? 0,
      total: frame.usage.total_tokens ?? 0,
    };
  }
  return out.text || out.usage ? out : null;
}

/**
 * Tokens, not dollars, by default.
 *
 * A cost figure needs a price table, and a price table hardcoded into a browser
 * extension is wrong the first time OpenAI reprices anything — quietly, and in
 * the direction of understating what the user is spending. So the cap is
 * counted in tokens, which the API reports exactly, and a dollar estimate only
 * appears if the user tells us their own rates. See docs/ROADMAP.md Phase 4.
 *
 * @param {{prompt: number, completion: number}} usage
 * @param {{inputPerM?: number, outputPerM?: number}} [rates]
 * @returns {number|null} dollars, or null when no rates are set
 */
export function estimateCost(usage, rates = {}) {
  const { inputPerM, outputPerM } = rates;
  if (!(inputPerM > 0) && !(outputPerM > 0)) return null;
  return ((usage.prompt ?? 0) * (inputPerM ?? 0) + (usage.completion ?? 0) * (outputPerM ?? 0)) / 1e6;
}

/** @returns {{allowed: boolean, used: number, cap: number}} */
export function checkCap(used, cap) {
  if (!(cap > 0)) return { allowed: true, used, cap: 0 };
  return { allowed: used < cap, used, cap };
}
