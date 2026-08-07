import { URL_KIND, PROMPT } from "./src/classify.js";
import { route, NONE, NAVIGATE, SEARCH, ASK, ANSWER, AUTO } from "./src/router.js";
import {
  loadSettings,
  saveMode,
  dismissEngineNudge,
  recordLaunch,
  readLaunches,
  readRowState,
  togglePinned,
  dismissRow as persistDismissal,
  loadAnswerSettings,
  readSpend,
  addSpend,
} from "./src/settings.js";
import { streamAnswer, estimateCost, checkCap } from "./src/answer.js";
import { createModeMenu } from "./src/modemenu.js";
import { buildRows, filterRows, CONVERSATION } from "./src/conversations.js";
import { hasHistoryAccess, requestHistoryAccess, readConversationVisits } from "./src/history.js";
import { renderRows, setActiveRow } from "./src/rows.js";

const form = document.getElementById("searchForm");
const input = document.getElementById("query");
const send = document.getElementById("send");
const nudge = document.getElementById("engineNudge");
const list = document.getElementById("rows");
const onboarding = document.getElementById("onboarding");
const emptyState = document.getElementById("emptyState");
const noMatches = document.getElementById("noMatches");

// --- mode ---------------------------------------------------------------------

let mode = AUTO;
/** Whether an API key is set. Answer mode degrades to Auto without one. */
let canAnswer = false;

const menu = createModeMenu({
  button: document.getElementById("modeButton"),
  menu: document.getElementById("modeMenu"),
  label: document.getElementById("modeLabel"),
  onSelect(next) {
    mode = next;
    saveMode(next);
    // Picking a mode that needs setting up should take you to the setting up,
    // not silently do something else.
    if (next === "answer" && !canAnswer) {
      globalThis.chrome?.runtime?.openOptionsPage?.();
      return;
    }
    input.focus();
  },
});

// The mode is read from storage asynchronously, but the user can type and hit
// Enter before that resolves. Submits await this rather than racing it, so the
// first query of a session is routed by the mode the user actually chose.
const ready = Promise.all([loadSettings(), loadAnswerSettings()]).then(([settings, answer]) => {
  mode = settings.mode;
  menu.setMode(settings.mode);
  nudge.hidden = settings.nudgeDismissed;

  canAnswer = Boolean(answer.apiKey && answer.model);
  if (!canAnswer) {
    document.getElementById("answerModeHint").textContent =
      "Answer on this page with your own OpenAI key. Choose this to set one up.";
  }
});

// --- rows ---------------------------------------------------------------------

/** Everything we could show, before the input filters it. */
let allRows = [];
/** Index into the currently *visible* rows, or -1 for "the input itself". */
let active = -1;
let visible = [];

// Not awaited: the listeners below must be attached before history resolves.
refreshRows();

async function refreshRows() {
  const granted = await hasHistoryAccess();
  onboarding.hidden = granted;

  const [launches, { pinned, dismissed }] = await Promise.all([readLaunches(), readRowState()]);
  const visits = granted ? await readConversationVisits() : [];

  allRows = buildRows({ visits, launches, pinned, dismissed });
  paint();
}

function paint() {
  visible = filterRows(allRows, input.value);
  active = -1;

  renderRows(list, visible, {
    onOpen: open,
    async onPin(row) {
      await togglePinned(row.id);
      await refreshRows();
    },
    async onDismiss(row) {
      await persistDismissal(row.id);
      await refreshRows();
    },
  });

  setActiveRow(list, input, -1);
  input.setAttribute("aria-expanded", String(visible.length > 0));

  const query = input.value.trim();
  // "Nothing yet" and "nothing matches" are different states and deserve
  // different words; the onboarding row is its own third answer.
  emptyState.hidden = visible.length > 0 || query !== "" || !onboarding.hidden;
  noMatches.hidden = visible.length > 0 || query === "" || allRows.length === 0;
}

function open(row) {
  if (row.kind === CONVERSATION) {
    navigate(row.url);
    return;
  }
  // A prompt row re-asks, through whatever mode is current — the destination is
  // a live setting, not something frozen at the time it was first asked.
  input.value = row.text;
  syncSend();
  go(row.text, null);
}

document.getElementById("enableHistory").addEventListener("click", async () => {
  // Must stay inside the click: Chrome refuses a permission request that is not
  // driven by a user gesture, and refuses it silently.
  const granted = await requestHistoryAccess();
  if (granted) await refreshRows();
  input.focus();
});

// --- submitting ---------------------------------------------------------------

// Enter is handled here rather than by form submit alone, because Cmd+Enter and
// Shift+Enter do not reliably raise a submit event across platforms.
input.addEventListener("keydown", (event) => {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      moveActive(1);
      return;

    case "ArrowUp":
      event.preventDefault();
      moveActive(-1);
      return;

    case "Escape":
      // Back out of the list first; a second Escape clears the box. Losing a
      // half-typed query to a keystroke meant for the selection is worse than
      // needing one more press.
      if (active >= 0) {
        active = -1;
        setActiveRow(list, input, -1);
        return;
      }
      input.value = "";
      paint();
      syncSend();
      return;

    case "Enter": {
      event.preventDefault();
      if (active >= 0 && visible[active]) {
        open(visible[active]);
        return;
      }
      const force = event.metaKey || event.ctrlKey ? PROMPT : event.shiftKey ? URL_KIND : null;
      go(input.value, force);
    }
  }
});

function moveActive(delta) {
  if (!visible.length) return;
  // -1 is the input, so the range is [-1, visible.length - 1] and wraps through
  // the input rather than jumping end to end.
  const span = visible.length + 1;
  active = ((active + 1 + delta + span) % span) - 1;
  setActiveRow(list, input, active);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  go(input.value, null);
});

async function go(raw, force) {
  await ready;
  const verdict = route(raw, { mode, force, canAnswer });

  switch (verdict.action) {
    case NONE:
      return;

    case NAVIGATE:
      navigate(verdict.url);
      return;

    case ASK:
      // Recorded before navigating: this document is about to be replaced, and
      // an await after the navigation starts is not guaranteed to finish.
      await recordLaunch(verdict.text);
      navigate(verdict.url);
      return;

    case ANSWER:
      await recordLaunch(verdict.text);
      await answerHere(verdict.text);
      return;

    case SEARCH:
      await recordLaunch(verdict.text);
      runSearch(verdict.text);
  }
}

// --- inline answers ------------------------------------------------------------

const answerPanel = document.getElementById("answer");
const answerText = document.getElementById("answerText");
const answerStatus = document.getElementById("answerStatus");
const answerMeta = document.getElementById("answerMeta");
const stopButton = document.getElementById("stopAnswer");

let inFlight = null;
let lastPrompt = "";

async function answerHere(prompt) {
  const config = await loadAnswerSettings();
  lastPrompt = prompt;

  answerPanel.hidden = false;
  answerText.textContent = "";
  answerMeta.textContent = "";
  answerStatus.textContent = "Answering…";
  stopButton.hidden = false;

  const spend = await readSpend();
  const cap = checkCap(spend.tokens, config.tokenCap);
  if (!cap.allowed) {
    // A budget that silently stops working is worse than no budget, so say what
    // happened and where to change it.
    answerStatus.textContent = "Daily token budget reached.";
    answerMeta.textContent =
      `${cap.used.toLocaleString()} of ${cap.cap.toLocaleString()} tokens used today. ` +
      `Raise or clear the budget in Archer's settings.`;
    stopButton.hidden = true;
    return;
  }

  inFlight = new AbortController();

  try {
    const { usage } = await streamAnswer({
      key: config.apiKey,
      model: config.model,
      prompt,
      signal: inFlight.signal,
      // Appending a text node rather than reassigning textContent keeps the
      // already-painted text on screen instead of reflowing it every frame.
      onText: (chunk) => answerText.append(chunk),
    });

    answerStatus.textContent = "Answer complete.";
    const total = await addSpend(usage.total);
    answerMeta.textContent = describeUsage(usage, total, config);
  } catch (error) {
    if (error.name === "AbortError") {
      answerStatus.textContent = "Stopped.";
    } else {
      answerStatus.textContent = "That didn't work.";
      answerMeta.textContent = error.message;
    }
  } finally {
    stopButton.hidden = true;
    inFlight = null;
  }
}

function describeUsage(usage, total, config) {
  const cost = estimateCost(usage, { inputPerM: config.rateInPerM, outputPerM: config.rateOutPerM });
  const money = cost === null ? "" : ` — about $${cost.toFixed(4)}`;
  const today = config.tokenCap > 0
    ? ` ${total.tokens.toLocaleString()} of ${config.tokenCap.toLocaleString()} today.`
    : ` ${total.tokens.toLocaleString()} today.`;
  return `${usage.total.toLocaleString()} tokens${money}.${today}`;
}

stopButton.addEventListener("click", () => inFlight?.abort());

document.getElementById("closeAnswer").addEventListener("click", () => {
  inFlight?.abort();
  answerPanel.hidden = true;
  input.focus();
});

// Hand the same prompt to a full conversation, where it can be followed up.
document.getElementById("continueInChatGPT").addEventListener("click", () => {
  const prompt = lastPrompt || input.value;
  if (!prompt.trim()) return;
  navigate("https://chatgpt.com/?q=" + encodeURIComponent(prompt.trim()));
});

/**
 * `chrome.tabs.update` rather than `location.assign` so the new tab page is
 * replaced instead of pushed onto session history (docs/ROADMAP.md §2.5 #7).
 *
 * Note this does *not* need the `tabs` permission: that permission gates
 * reading a tab's url/title/favicon, not setting the current tab's address.
 * See the permissions ledger in docs/ROADMAP.md.
 */
function navigate(url) {
  if (globalThis.chrome?.tabs?.update) {
    chrome.tabs.update({ url });
    return;
  }
  window.location.assign(url);
}

/**
 * Hands the query to whatever the user set as their default search engine.
 *
 * Using chrome.search rather than a hardcoded endpoint is both the product
 * behavior we want — with OpenAI's "ChatGPT search" extension installed the
 * default engine *is* ChatGPT — and the only Web-Store-compliant way for a new
 * tab page to run a search. See docs/ROADMAP.md §0.5 and §2.2.
 */
function runSearch(text) {
  if (globalThis.chrome?.search?.query) {
    chrome.search.query({ text, disposition: "CURRENT_TAB" });
    return;
  }
  // Only reached when newtab.html is opened as a plain file for development,
  // where the chrome.* APIs do not exist. Never runs in the packed extension.
  window.location.assign("https://www.google.com/search?q=" + encodeURIComponent(text));
}

// --- the default-engine hint ---------------------------------------------------

// There is no API that reports the default search engine, so this never claims
// to know what yours is — it says what Archer does and leaves the conclusion to
// you. A hint, never a blocker (docs/ROADMAP.md Phase 2).
document.getElementById("dismissNudge").addEventListener("click", () => {
  nudge.hidden = true;
  dismissEngineNudge();
  input.focus();
});

// --- keyboard reach ------------------------------------------------------------

// Chrome puts the caret in the address bar on ⌘T and an NTP override cannot
// take it back (docs/ROADMAP.md §2.4). But focus does land on the page when the
// tab is opened any other way, and then a keystroke should reach the input
// rather than fall on the floor. Focusing during keydown is enough — the
// character's default action runs afterwards, against the newly focused field.
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTextField(event.target) || menu.isOpen()) return;

  if (event.key === "/") {
    event.preventDefault(); // the slash is the gesture, not content
    input.focus();
    return;
  }
  // A single-character key is printable; "Shift", "Tab", "F3" and friends are not.
  if (event.key.length === 1) input.focus();
});

function isTextField(node) {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node?.isContentEditable;
}

// --- send button ---------------------------------------------------------------

input.addEventListener("input", () => {
  syncSend();
  paint();
});
syncSend();

/** The send control is the page's primary action, so it stays inert until
    there is actually something to send. */
function syncSend() {
  send.disabled = input.value.trim() === "";
}
