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
  const response = await fetch(`${ENDPOINT}/chat/completions`, {
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
    const { value, done } = await reader.read();
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

/** Lists the models this key can actually reach, newest first. */
export async function listModels(key, signal) {
  const response = await fetch(`${ENDPOINT}/models`, {
    signal,
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(await describeFailure(response));

  const body = await response.json();
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id) => typeof id === "string")
    .sort();
}

async function describeFailure(response) {
  // OpenAI's error bodies are the useful part; the status alone sends people
  // hunting. Fall back to the status when the body is not JSON.
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message ?? "";
  } catch {
    /* not JSON */
  }
  if (response.status === 401) return detail || "That key was rejected. Check it and try again.";
  if (response.status === 429) return detail || "Rate limited, or this key is out of quota.";
  return detail || `The API returned ${response.status}.`;
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
