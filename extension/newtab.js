import { URL_KIND, PROMPT } from "./src/classify.js";
import { route, NONE, NAVIGATE, SEARCH, ASK, ANSWER, AUTO, MODES } from "./src/router.js";
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
import { readLibrary } from "./src/settings.js";
import { streamAnswer, estimateCost, checkCap } from "./src/answer.js";
import { createModeMenu } from "./src/modemenu.js";
import { buildRows, filterRows, LINK_KINDS } from "./src/conversations.js";
import { hasHistoryAccess, requestHistoryAccess, readConversationVisits } from "./src/history.js";
import {
  hasTilesAccess,
  requestTilesAccess,
  hasClosedTabsAccess,
  requestClosedTabsAccess,
  readTopSites,
  readRecentlyClosed,
} from "./src/browsing.js";
import { renderRows, setActiveRow } from "./src/rows.js";
import { findTemplates, nextPlaceholder, parseSlash } from "./src/library.js";
import { startClock, refreshWeather, renderFavourites, wireFavouriteForm } from "./src/dashboard.js";

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
    syncTargets();
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
  syncTargets();
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

// --- dashboard -------------------------------------------------------------------

startClock();
refreshWeather();
renderFavourites({ onNavigate: navigate });
wireFavouriteForm({ onNavigate: navigate });

document.getElementById("openSettings").addEventListener("click", () => {
  globalThis.chrome?.runtime?.openOptionsPage?.();
});

document.getElementById("weather").addEventListener("click", () => {
  globalThis.chrome?.runtime?.openOptionsPage?.();
});

// --- the target pills ---------------------------------------------------------------

const targets = [...document.querySelectorAll(".target")];

for (const pill of targets) {
  pill.addEventListener("click", () => {
    mode = pill.dataset.mode;
    menu.setMode(mode);
    saveMode(mode);
    syncTargets();
    input.focus();
  });
}

/** Keeps the pills and the top-bar menu showing the same one mode. */
function syncTargets() {
  for (const pill of targets) pill.setAttribute("aria-pressed", String(pill.dataset.mode === mode));
}

async function refreshRows() {
  const [granted, tiles, closedTabs] = await Promise.all([
    hasHistoryAccess(),
    hasTilesAccess(),
    hasClosedTabsAccess(),
  ]);
  onboarding.hidden = granted;

  const [launches, { pinned, dismissed }, library] = await Promise.all([
    readLaunches(),
    readRowState(),
    readLibrary(),
  ]);

  const [visits, sites, closed] = await Promise.all([
    granted ? readConversationVisits() : [],
    tiles ? readTopSites() : [],
    closedTabs ? readRecentlyClosed() : [],
  ]);

  templates = library;
  allRows = buildRows({ visits, launches, sites, closed, pinned, dismissed });
  paint();
}

/** Saved prompts, kept in memory so `/` can filter them without a round trip. */
let templates = [];

function paint() {
  // A leading slash turns the row list into the prompt library. The rows and
  // the library are the same surface — one list, one set of arrow keys — rather
  // than a second popup with its own focus model.
  const slash = parseSlash(input.value);
  if (slash) {
    visible = findTemplates(templates, slash.name).map((t) => ({
      kind: "template",
      id: `template:${t.id}`,
      title: t.name,
      text: t.text,
      template: t,
      at: 0,
    }));
  } else {
    visible = filterRows(allRows, input.value);
  }
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
  if (LINK_KINDS.has(row.kind)) {
    navigate(row.url);
    return;
  }
  if (row.kind === "template") {
    useTemplate(row.template);
    return;
  }
  // A prompt row re-asks, through whatever mode is current — the destination is
  // a live setting, not something frozen at the time it was first asked.
  input.value = row.text;
  syncSend();
  go(row.text, null);
}

/**
 * Drops a saved prompt into the box and selects its first `{{blank}}`, so the
 * next thing typed replaces it. Tab moves to the next blank.
 */
function useTemplate(template) {
  input.value = template.text;
  input.focus();
  syncSend();
  paint();
  selectPlaceholder(0);
}

function selectPlaceholder(from) {
  const slot = nextPlaceholder(input.value, from);
  if (!slot) {
    input.setSelectionRange(input.value.length, input.value.length);
    return false;
  }
  input.setSelectionRange(slot.start, slot.end);
  return true;
}

// --- the + menu ----------------------------------------------------------------

const plusMenu = createModeMenu({
  button: document.getElementById("plusButton"),
  menu: document.getElementById("plusMenu"),
  // The + button is an icon, so there is no label to keep in sync; a throwaway
  // node absorbs the writes the menu makes.
  label: document.createElement("span"),
  onSelect: (action) => runPlusAction(action),
});

async function runPlusAction(action) {
  switch (action) {
    case "paste": {
      const text = await readClipboard();
      if (text) {
        // Appended, not replaced: the + is for adding context to what you were
        // already writing.
        input.value = input.value ? `${input.value.trimEnd()} ${text}` : text;
        syncSend();
        paint();
      }
      input.focus();
      return;
    }

    case "library":
      input.value = "/";
      input.focus();
      syncSend();
      paint();
      return;

    case "tiles":
      await requestTilesAccess();
      await refreshRows();
      input.focus();
      return;

    case "closed":
      // Kept separate from top sites because it costs strictly more: closed-tab
      // titles are gated on `tabs`, whose prompt reads "Read your browsing
      // history". Bundling it into one click would have hidden that.
      await requestClosedTabsAccess();
      await refreshRows();
      input.focus();
      return;

    case "settings":
      globalThis.chrome?.runtime?.openOptionsPage?.();
  }
}

async function readClipboard() {
  try {
    if (globalThis.chrome?.permissions?.request) {
      const granted = await chrome.permissions.request({ permissions: ["clipboardRead"] });
      if (!granted) return "";
    }
    return (await navigator.clipboard.readText()).trim();
  } catch {
    // Denied, or nothing readable on the clipboard. Nothing useful to say.
    return "";
  }
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
    case "Tab":
      // Only while a template still has blanks left — otherwise Tab has to stay
      // Tab, or the search box becomes a place keyboard users cannot leave.
      if (!event.shiftKey && nextPlaceholder(input.value, input.selectionEnd)) {
        event.preventDefault();
        selectPlaceholder(input.selectionEnd);
      }
      return;

    case "ArrowDown":
      event.preventDefault();
      // Alt+↑/↓ cycles the destination. The roadmap wanted Tab for this; Tab is
      // how keyboard users leave a text field, and taking it costs more than
      // the shortcut is worth when the mode menu is right there.
      if (event.altKey) cycleMode(1);
      else moveActive(1);
      return;

    case "ArrowUp":
      event.preventDefault();
      if (event.altKey) cycleMode(-1);
      else moveActive(-1);
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

function cycleMode(delta) {
  const at = MODES.indexOf(mode);
  const next = MODES[(at + delta + MODES.length) % MODES.length];
  mode = next;
  menu.setMode(next);
  saveMode(next);
  syncTargets();
}

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
