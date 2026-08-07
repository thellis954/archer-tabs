import { URL_KIND, PROMPT } from "./src/classify.js";
import { route, NONE, NAVIGATE, SEARCH, ASK, AUTO } from "./src/router.js";
import { loadSettings, saveMode, dismissEngineNudge, recordLaunch } from "./src/settings.js";
import { createModeMenu } from "./src/modemenu.js";

const form = document.getElementById("searchForm");
const input = document.getElementById("query");
const send = document.getElementById("send");
const nudge = document.getElementById("engineNudge");

// --- mode ---------------------------------------------------------------------

let mode = AUTO;

const menu = createModeMenu({
  button: document.getElementById("modeButton"),
  menu: document.getElementById("modeMenu"),
  label: document.getElementById("modeLabel"),
  onSelect(next) {
    mode = next;
    saveMode(next);
    input.focus();
  },
});

// The mode is read from storage asynchronously, but the user can type and hit
// Enter before that resolves. Submits await this rather than racing it, so the
// first query of a session is routed by the mode the user actually chose.
const ready = loadSettings().then((settings) => {
  mode = settings.mode;
  menu.setMode(settings.mode);
  nudge.hidden = settings.nudgeDismissed;
});

// --- submitting ---------------------------------------------------------------

// Enter is handled here rather than by form submit alone, because Cmd+Enter and
// Shift+Enter do not reliably raise a submit event across platforms.
input.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    input.value = "";
    syncSend();
    return;
  }
  if (event.key !== "Enter") return;

  event.preventDefault();
  const force = event.metaKey || event.ctrlKey ? PROMPT : event.shiftKey ? URL_KIND : null;
  go(input.value, force);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  go(input.value, null);
});

async function go(raw, force) {
  await ready;
  const verdict = route(raw, { mode, force });

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

    case SEARCH:
      await recordLaunch(verdict.text);
      runSearch(verdict.text);
  }
}

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

input.addEventListener("input", syncSend);
syncSend();

/** The send control is the page's primary action, so it stays inert until
    there is actually something to send. */
function syncSend() {
  send.disabled = input.value.trim() === "";
}
