import { URL_KIND, PROMPT } from "./src/classify.js";
import {
  route,
  NONE,
  NAVIGATE,
  SEARCH,
  ASK,
  ANSWER,
  AUTO,
  GOOGLE,
  SEARCH_MODE,
  MODES,
  placeholderFor,
} from "./src/router.js";
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
import { startClock, refreshWeather, renderFavorites, wireFavoriteForm } from "./src/dashboard.js";
import { extract, KIND_LABEL } from "./src/extract.js";

const form = document.getElementById("searchForm");
const input = document.getElementById("query");
const send = document.getElementById("send");
const nudge = document.getElementById("engineNudge");
const list = document.getElementById("rows");
const onboarding = document.getElementById("onboarding");
const emptyState = document.getElementById("emptyState");
const noMatches = document.getElementById("noMatches");

// --- mode ---------------------------------------------------------------------

let mode = GOOGLE;
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
      openSettings();
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
  nudgeDismissed = settings.nudgeDismissed;
  menu.setMode(settings.mode);
  syncTargets();

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
renderFavorites({ onNavigate: navigate });
wireFavoriteForm({ onNavigate: navigate });

document.getElementById("openSettings").addEventListener("click", openSettings);
document.getElementById("weather").addEventListener("click", openSettings);

/**
 * Opens the settings page in a new tab.
 *
 * **Not `chrome.runtime.openOptionsPage()`**, which is the obvious call and the
 * wrong one here. When the caller is the new tab page Chrome takes a special
 * path and *replaces* that tab rather than opening one — measured directly with
 * a real click in a headed browser: two tabs before, two after, and the new tab
 * had become options.html. From the user's side that is indistinguishable from
 * the button doing nothing, and it destroys the page they were on.
 *
 * `chrome.tabs.create` needs no permission (`tabs` gates *reading* a tab's
 * url/title, not opening one) and always visibly does something.
 */
function openSettings() {
  const url = globalThis.chrome?.runtime?.getURL?.("options.html");
  if (!url) return;
  try {
    if (globalThis.chrome?.tabs?.create) {
      chrome.tabs.create({ url });
      return;
    }
  } catch {
    /* fall through to replacing this page, which at least gets you there */
  }
  navigate(url);
}

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

/** Whether the default-engine hint has been dismissed for good. */
let nudgeDismissed = false;

/** Keeps the pills, the top-bar menu, the placeholder and the hint on one mode. */
function syncTargets() {
  for (const pill of targets) pill.setAttribute("aria-pressed", String(pill.dataset.mode === mode));
  // The box says where the next Enter goes. Nothing else on the page does.
  input.placeholder = placeholderFor(mode, canAnswer);
  // The hint is about the default engine, so it only makes sense in the two
  // modes that use one. In Google mode "prompts go to your default search
  // engine" is simply untrue, and a page that contradicts its own buttons
  // teaches you to stop reading it.
  nudge.hidden = nudgeDismissed || !(mode === AUTO || mode === SEARCH_MODE);
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
  // Only while the typing still looks like a filter. Past that you are writing a
  // prompt, and "no rows match" on every fresh question is noise.
  const looksLikeFilter = query.length > 0 && query.length <= 24;
  noMatches.hidden = visible.length > 0 || !looksLikeFilter || allRows.length === 0;
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
    case "attach":
      // The click on the hidden input has to happen inside this one, or Chrome
      // treats the picker as unrequested and ignores it.
      document.getElementById("attachInput").click();
      return;

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
      // The same call as the gear, for the same reason — see openSettings().
      openSettings();
  }
}

/**
 * Big enough for a real document, small enough that it is still context.
 *
 * A 20-page PDF or a photo off a phone both land under 10 MB; a video does not,
 * and should not. What actually reaches a model is capped separately, by
 * MAX_TEXT_CHARS for text and by the hand-off budget below.
 */
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

/**
 * How much attached text a hand-off can carry.
 *
 * ChatGPT, Claude and Perplexity are reached by putting the prompt in a URL,
 * and a URL is not a file transport — Chrome and the sites themselves give up
 * somewhere past a few thousand characters. Answer mode has no such limit
 * because it posts a request body, so the whole file goes.
 */
const HANDOFF_BUDGET = 4000;

/** In-memory only: an attachment is for the next send, not a saved document. */
let attachments = [];

document.getElementById("attachInput").addEventListener("change", async (event) => {
  const files = [...(event.target.files ?? [])];
  event.target.value = ""; // so picking the same file twice still fires
  if (!files.length) return;

  // Reading a PDF or a spreadsheet is not instant, and a picker that closes
  // onto no visible change reads as a failure.
  say(files.length === 1 ? `Reading ${files[0].name}\u2026` : `Reading ${files.length} files\u2026`);

  // Collected rather than said as they happen: paintAttachments() owns the status
  // line and clears it when nothing is attached, so a message written inside this
  // loop is wiped a moment later — and if *every* file was rejected, the only
  // thing the user would see is a picker that closed and did nothing.
  const refused = [];

  for (const file of files) {
    if (file.size > MAX_ATTACH_BYTES) {
      refused.push(`${file.name} is ${Math.round(file.size / 1024 / 1024)} MB — the limit is 10 MB`);
      continue;
    }
    try {
      attachments.push(await extract(file));
    } catch {
      // extract() is written not to throw, so reaching here means the browser
      // itself could not hand the file over — a disconnected drive, say.
      refused.push(`${file.name} could not be read`);
    }
  }

  paintAttachments();
  if (refused.length) say(refused.join(". ") + ".");
  syncSend();
  input.focus();
});

function paintAttachments() {
  const list = document.getElementById("attachments");
  const template = document.getElementById("chipTemplate");
  list.replaceChildren();

  for (const [index, file] of attachments.entries()) {
    const node = template.content.firstElementChild.cloneNode(true);
    // A filename is text the user's filesystem chose, not markup.
    node.querySelector(".chipName").textContent = file.name;
    // What the chip says is what actually goes: the kind for a file that was
    // read, and the reason for one that was not. A chip that reads "PDF" beside
    // a scan nobody could extract would be a lie the model then answers from.
    node.querySelector(".chipSize").textContent = file.note
      ? `${KIND_LABEL[file.kind] ?? "file"} — ${file.note}`
      : describeAttachment(file);

    const remove = node.querySelector(".chipRemove");
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.addEventListener("click", () => {
      attachments.splice(index, 1);
      paintAttachments();
      syncSend();
      input.focus();
    });

    list.append(node);
  }

  if (!attachments.length) {
    say("");
    return;
  }

  const images = attachments.filter((f) => f.dataUrl).length;
  if (images && !canAnswer) {
    // An image can only be *sent* on the Answer-here path, which posts a request
    // body. A hand-off puts the prompt in a URL, and a URL cannot carry a photo.
    say("Set up Answer here in settings to send images — a website hand-off can only carry text.");
  } else {
    say(`Attached. Type your question — the ${attachments.length === 1 ? "file goes" : "files go"} with it.`);
  }
}

/** "Excel · 42 rows" is more use on a chip than "18 KB". */
function describeAttachment(file) {
  const kind = KIND_LABEL[file.kind] ?? "file";
  if (file.dataUrl) return `${kind} — ${sizeOf(file.size)}`;
  const words = file.text ? file.text.trim().split(/\s+/).length : 0;
  return words ? `${kind} — ${words.toLocaleString()} words` : `${kind} — ${sizeOf(file.size)}`;
}

const sizeOf = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * The prompt as actually sent: what you typed, then each file, fenced and named
 * so the model can tell instruction from attachment.
 *
 * Images are not in here — they travel as their own message part, not as text —
 * and neither is the body of a file that could not be read. What a file that
 * could not be read contributes instead is one honest line saying so, because
 * the alternative is a model that answers about a document it never saw.
 */
function composePrompt(typed, { budget = Infinity } = {}) {
  const readable = attachments.filter((f) => f.text);
  const unreadable = attachments.filter((f) => !f.text && !f.dataUrl);
  if (!readable.length && !unreadable.length) return { text: typed, trimmed: false };

  let trimmed = false;
  let out = typed.trim();
  let room = budget - out.length;

  for (const file of readable) {
    let body = file.text;
    const frame = `\n\n--- ${file.name} ---\n\n--- end of ${file.name} ---`;

    if (Number.isFinite(room)) {
      const available = room - frame.length;
      if (available <= 0) {
        trimmed = true;
        break;
      }
      if (body.length > available) {
        body = body.slice(0, available);
        trimmed = true;
      }
      room -= frame.length + body.length;
    }
    out += `\n\n--- ${file.name} ---\n${body}\n--- end of ${file.name} ---`;
  }

  for (const file of unreadable) {
    const line = `\n\n--- ${file.name} (${KIND_LABEL[file.kind] ?? "file"}: ${file.note ?? "not readable"}) ---`;
    if (Number.isFinite(room) && room - line.length <= 0) {
      trimmed = true;
      break;
    }
    room -= line.length;
    out += line;
  }

  return { text: out, trimmed };
}

/** One line under the box, for things that are not errors but need saying. */
function say(message) {
  const node = document.getElementById("attachStatus");
  node.textContent = message;
  node.hidden = !message;
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

// Chrome keeps a pre-rendered new tab page around, so a tab created before a
// change would show the state as it was when it was built. Watching storage
// means every open tab agrees with every other one.
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") return;

  if ("favorites" in changes || "favourites" in changes) renderFavorites({ onNavigate: navigate });
  if ("weatherCache" in changes || "weatherPlace" in changes || "weatherUnit" in changes) refreshWeather();
  if ("launches" in changes || "pinned" in changes || "dismissed" in changes || "library" in changes) {
    refreshRows();
  }
  if ("mode" in changes) {
    const next = changes.mode.newValue;
    if (typeof next === "string" && next !== mode) {
      mode = next;
      menu.setMode(next);
      syncTargets();
    }
  }
});

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

  // Attachments ride with a prompt, never with a URL — "open this address" has
  // nothing to attach to.
  if (attachments.length && (verdict.action === SEARCH || verdict.action === ANSWER || verdict.action === ASK)) {
    const budget = verdict.action === ANSWER ? Infinity : HANDOFF_BUDGET;
    const composed = composePrompt(raw, { budget });

    if (composed.trimmed) {
      say(
        "The attachment was trimmed to fit the address bar. Set up Answer here in settings to send " +
          "the whole file.",
      );
    }
    // A hand-off is a URL, and a URL cannot carry a picture. Better to say the
    // image is being left behind than to let it disappear between two screens.
    if (verdict.action !== ANSWER && attachments.some((f) => f.dataUrl)) {
      say("Images can only be sent by Answer here — a website hand-off carries text only.");
    }
    const withFiles = route(composed.text, { mode, force: PROMPT, canAnswer });
    // Read off before the list is cleared: only Answer here can carry them, and
    // only because it posts a body rather than putting the prompt in a URL.
    const images = withFiles.action === ANSWER ? attachments.filter((f) => f.dataUrl).map((f) => f.dataUrl) : [];
    await recordLaunch(raw.trim() || attachments[0].name);
    attachments = [];
    paintAttachments();

    if (withFiles.action === ANSWER) return void (await answerHere(withFiles.text, images));
    if (withFiles.action === ASK) return void navigate(withFiles.url);
    return void runSearch(withFiles.text);
  }

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

async function answerHere(prompt, images = []) {
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
      images,
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
 * **The tab id is not optional.** `chrome.tabs.update({url})` with no id
 * navigates whatever tab is *active*, which is not necessarily the one running
 * this page — Chrome pre-renders the new tab page, and a background new tab
 * that submits would send some other tab somewhere. Measured directly: the
 * page's own tab id and the active tab id differ.
 *
 * Neither `getCurrent` nor `update` needs the `tabs` permission; that permission
 * gates *reading* a tab's url/title/favicon, which this never does.
 */
async function navigate(url) {
  try {
    const tab = await globalThis.chrome?.tabs?.getCurrent?.();
    if (tab?.id != null && chrome.tabs?.update) {
      chrome.tabs.update(tab.id, { url });
      return;
    }
  } catch {
    /* fall through to the plain navigation below */
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
  nudgeDismissed = true;
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
  send.disabled = input.value.trim() === "" && attachments.length === 0;
}
