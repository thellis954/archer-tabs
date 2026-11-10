// The settings page: where questions go, how Answer here answers (Chrome's
// built-in AI or the user's own key), the model, the budget, and the rest.
//
// Every message here is set with textContent. Model ids come back from the API
// and the error strings come back from the API too — neither is ours to trust
// as markup.

import {
  loadAnswerSettings,
  saveAnswerSettings,
  readSpend,
  DEFAULT_TOKEN_CAP,
  readLibrary,
  saveLibrary,
  readLaunches,
  clearLaunches,
  readWeatherSettings,
  saveWeatherSettings,
  saveWeatherCache,
  loadSettings,
  saveMode,
  saveFallback,
} from "./src/settings.js";
import { listModels, checkKey, keyProblem, pickModel, estimateCost, API_ORIGIN } from "./src/answer.js";
import {
  builtinAvailability,
  openSession,
  describeBuiltinFailure,
  percent,
  AVAILABLE,
  DOWNLOADABLE,
  DOWNLOADING,
} from "./src/builtin.js";
import { targetName } from "./src/router.js";

import { findPlace, fetchWeather, WEATHER_ORIGINS } from "./src/weather.js";
import { variableNames } from "./src/library.js";
import { summarise, toMarkdown } from "./src/analytics.js";
import { GRANTS, isGranted, grant, revoke } from "./src/permissions.js";

const $ = (id) => document.getElementById(id);

const apiKey = $("apiKey");
const keyStatus = $("keyStatus");
const modelCard = $("modelCard");
const modelSelect = $("model");
const modelStatus = $("modelStatus");
const budgetCard = $("budgetCard");

let settings = await loadAnswerSettings();
let builtin = await builtinAvailability();
render();

function render() {
  apiKey.value = settings.apiKey;
  $("tokenCap").value = settings.tokenCap ?? DEFAULT_TOKEN_CAP;
  $("rateIn").value = settings.rateInPerM || "";
  $("rateOut").value = settings.rateOutPerM || "";

  const hasKey = Boolean(settings.apiKey);
  modelCard.hidden = !hasKey;
  budgetCard.hidden = !hasKey;
  // A nav link to a hidden section scrolls to nothing.
  $("navModel").hidden = !hasKey;
  $("navBudget").hidden = !hasKey;
  setState(
    "stateAnswers",
    hasKey && settings.model ? "Your OpenAI key" : builtin === AVAILABLE ? "Chrome's built-in AI" : hasKey ? "Key set, no model" : "Off",
    (hasKey && Boolean(settings.model)) || builtin === AVAILABLE,
  );
  setState("stateModel", settings.model || "None chosen", Boolean(settings.model));
  setState(
    "stateBudget",
    settings.tokenCap > 0 ? `${settings.tokenCap.toLocaleString()} tokens a day` : "No limit",
    settings.tokenCap > 0,
  );

  if (hasKey) {
    setModelOptions(settings.model ? [settings.model] : [], settings.model);
    showUsage();
  }
}

/**
 * The one line of state a section shows in its header.
 *
 * Nine cards with no summary meant the only way to learn whether weather was on
 * was to scroll to it and read the form. `on` drives the accent, so "off" and
 * "not set up" never look like an alarm.
 */
function setState(id, text, on = false) {
  const node = $(id);
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("isOn", Boolean(on));
}

function say(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle("isError", isError);
}

// --- default destination -------------------------------------------------------------

const defaultMode = $("defaultMode");
defaultMode.value = (await loadSettings()).mode;
paintModeState();

/** Just the destination's name — the option text carries an explanation too. */
function paintModeState() {
  const label = (defaultMode.selectedOptions[0]?.textContent ?? "").split(" — ")[0];
  setState("stateDestination", label, true);
}

const fallbackMode = $("fallbackMode");
fallbackMode.value = (await loadSettings()).fallback;

fallbackMode.addEventListener("change", async () => {
  await saveFallback(fallbackMode.value);
  say($("modeStatus"), `When Answer here can't answer, questions go to ${targetName(fallbackMode.value)}.`);
});

defaultMode.addEventListener("change", async () => {
  await saveMode(defaultMode.value);
  paintModeState();
  const label = defaultMode.selectedOptions[0]?.textContent ?? defaultMode.value;
  say($("modeStatus"), `New tabs will use ${label.split(" — ")[0]}.`);
});

// --- weather ----------------------------------------------------------------------

const weather = await readWeatherSettings();
$("place").value = weather.place?.name ?? "";
$("unit").value = weather.unit;
paintWeatherState(weather.place?.name);

function paintWeatherState(place) {
  setState("stateWeather", place || "Off", Boolean(place));
}

$("savePlace").addEventListener("click", async () => {
  const query = $("place").value.trim();
  if (!query) {
    say($("placeStatus"), "Type a town or city first.", true);
    return;
  }

  // Inside the click: Chrome refuses a permission request without a gesture.
  const granted = await requestWeatherAccess();
  if (!granted) {
    // Not a dead end. Chrome's popup opens at the top of the window with Deny
    // focused, so the common way to land here is never to have seen it — and
    // the typed place is kept so saying yes is one click, not a retype.
    say(
      $("placeStatus"),
      "Not saved yet — Chrome asks permission to reach Open-Meteo in a popup at the top of the window, " +
        "and Deny is its default. Your place is still typed in: press Save place again and choose Allow. " +
        "You can also turn Weather on under Permissions at the bottom of this page.",
      true,
    );
    await paintWeatherAccess();
    return;
  }

  say($("placeStatus"), "Looking that up…");
  try {
    const unit = $("unit").value;
    const place = await findPlace(query);
    // Fetched before saving, so a place that resolves but has no forecast never
    // becomes a permanently blank card on the new tab.
    const reading = await fetchWeather({ ...place, unit });

    await saveWeatherSettings({ place, unit });
    await saveWeatherCache(reading);
    $("place").value = place.name;
    paintWeatherState(place.name);
    say($("placeStatus"), `Showing weather for ${place.name}.`);
    await paintWeatherAccess();
  } catch (error) {
    say($("placeStatus"), error.message, true);
  }
});

/**
 * Says up front that a popup is coming, so it is expected rather than a
 * surprise to be dismissed — and names the button once it is not needed.
 */
async function paintWeatherAccess() {
  const has = await hasWeatherAccess();
  $("savePlace").textContent = has ? "Save place" : "Allow & save place";
  const hint = $("weatherAccessHint");
  hint.hidden = has;
}

async function hasWeatherAccess() {
  if (!globalThis.chrome?.permissions?.contains) return true;
  try {
    return await chrome.permissions.contains({ origins: WEATHER_ORIGINS });
  } catch {
    return false;
  }
}

await paintWeatherAccess();

$("clearPlace").addEventListener("click", async () => {
  await saveWeatherSettings({ place: null });
  await saveWeatherCache(null);
  $("place").value = "";
  paintWeatherState(null);
  say($("placeStatus"), "Weather turned off. The card disappears from the new tab.");
});

async function requestWeatherAccess() {
  if (!globalThis.chrome?.permissions?.request) return true; // plain-file dev
  try {
    if (await chrome.permissions.contains({ origins: WEATHER_ORIGINS })) return true;
    return await chrome.permissions.request({ origins: WEATHER_ORIGINS });
  } catch {
    return false;
  }
}

// --- saved prompts --------------------------------------------------------------

const templateList = $("templates");

await renderTemplates();

async function renderTemplates() {
  const templates = await readLibrary();
  templateList.replaceChildren();
  setState("statePrompts", templates.length ? `${templates.length} saved` : "None yet", templates.length > 0);

  if (!templates.length) {
    const empty = document.createElement("li");
    empty.className = "templateEmpty";
    empty.textContent = "No saved prompts yet.";
    templateList.append(empty);
    return;
  }

  for (const template of templates) {
    const item = document.createElement("li");
    item.className = "template";

    const name = document.createElement("span");
    name.className = "templateName";
    name.textContent = `/${template.name}`;

    const text = document.createElement("span");
    text.className = "templateText";
    text.textContent = template.text;

    const blanks = variableNames(template.text);
    const meta = document.createElement("span");
    meta.className = "templateMeta";
    meta.textContent = blanks.length ? blanks.map((b) => `{{${b}}}`).join(" ") : "";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "rowBtn";
    remove.setAttribute("aria-label", `Delete ${template.name}`);
    remove.textContent = "✕";
    remove.addEventListener("click", async () => {
      const rest = (await readLibrary()).filter((t) => t.id !== template.id);
      await saveLibrary(rest);
      await renderTemplates();
      say($("templateStatus"), `Deleted /${template.name}.`);
    });

    item.append(name, text, meta, remove);
    templateList.append(item);
  }
}

$("addTemplate").addEventListener("click", async () => {
  // A name with whitespace could never be typed after a slash, so it is
  // normalised rather than rejected.
  const name = $("templateName").value.trim().replace(/\s+/g, "-").toLowerCase();
  const text = $("templateText").value.trim();

  if (!name || !text) {
    say($("templateStatus"), "A saved prompt needs both a name and some text.", true);
    return;
  }

  const templates = await readLibrary();
  const existing = templates.findIndex((t) => t.name === name);
  const entry = { id: existing >= 0 ? templates[existing].id : `${name}-${templates.length}`, name, text };

  if (existing >= 0) templates[existing] = entry;
  else templates.push(entry);

  await saveLibrary(templates);
  $("templateName").value = "";
  $("templateText").value = "";
  await renderTemplates();
  say($("templateStatus"), existing >= 0 ? `Updated /${name}.` : `Saved /${name}.`);
});

// --- analytics and export ---------------------------------------------------------

await renderAnalytics();

async function renderAnalytics() {
  const launches = await readLaunches();
  const summary = summarise(launches);
  const box = $("analytics");
  box.replaceChildren();

  if (!summary.total) {
    const empty = document.createElement("p");
    empty.className = "prose";
    empty.textContent = "Nothing asked from the new tab page yet.";
    box.append(empty);
    return;
  }

  const stats = [
    ["Prompts", summary.total.toLocaleString()],
    ["Per day", String(summary.perDay)],
    ["Words each", String(summary.averageWords)],
    ["Busiest hour", `${String(summary.busiestHour).padStart(2, "0")}:00`],
  ];

  const grid = document.createElement("dl");
  grid.className = "stats";
  for (const [label, value] of stats) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    grid.append(term, detail);
  }
  box.append(grid);

  if (summary.topWords.length) {
    const heading = document.createElement("p");
    heading.className = "hint";
    heading.textContent = "What you ask about most";
    box.append(heading);

    const words = document.createElement("ul");
    words.className = "words";
    for (const { word, count } of summary.topWords) {
      const item = document.createElement("li");
      // A word out of the launch log is text the user typed, not markup.
      item.textContent = `${word} · ${count}`;
      words.append(item);
    }
    box.append(words);
  }
}

$("exportMarkdown").addEventListener("click", async () => {
  const launches = await readLaunches();
  const markdown = toMarkdown(launches, { now: Date.now() });

  // A blob and a synthetic click: no `downloads` permission needed, and the
  // file never leaves the machine on its way to disk.
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `archer-prompts-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(url);

  say($("dataStatus"), `Exported ${launches.length} prompt${launches.length === 1 ? "" : "s"}.`);
});

$("clearHistory").addEventListener("click", async () => {
  await clearLaunches();
  await renderAnalytics();
  say($("dataStatus"), "Prompt history cleared. Saved prompts and pins are untouched.");
});

// --- the key ------------------------------------------------------------------

$("saveKey").addEventListener("click", async () => {
  const key = apiKey.value.trim();
  const problem = keyProblem(key);
  if (problem) {
    say(keyStatus, problem, true);
    return;
  }

  // Must stay inside the click: Chrome refuses a permission request without a
  // user gesture. Reaching api.openai.com at all needs this origin, and asking
  // here means it is never in the install-time prompt.
  const granted = await requestApiAccess();
  await paintApiAccess();
  if (!granted) {
    say(
      keyStatus,
      "Not saved yet — Chrome asks permission to reach api.openai.com in a popup at the top of the window, " +
        "and Deny is its default. Your key is still typed in: press Save key again and choose Allow.",
      true,
    );
    return;
  }

  say(keyStatus, "Checking the key with OpenAI…");
  try {
    const { models, model: picked } = await checkKey(key);
    // A model chosen earlier that this key can still reach is kept; otherwise
    // the pick. Saving a key used to leave the model empty, so Answer here
    // never answered (QA P1-2).
    const model = models.includes(settings.model) ? settings.model : picked ?? "";
    await saveAnswerSettings({ apiKey: key, model });
    settings = await loadAnswerSettings();
    render();
    setModelOptions(models, settings.model);
    say(
      keyStatus,
      model
        ? `Saved, and it works. Answers will use ${model} — nothing else to set.`
        : models.length
          ? "Saved. This key can't reach any of the models Archer picks from — choose one under Model."
          : "Saved, but this key can't reach any chat models. Check the key's project permissions on platform.openai.com.",
      !model,
    );
  } catch (error) {
    // The key is not stored unless it worked — a saved key that 401s would be a
    // silent failure on the new tab page later.
    say(keyStatus, error.message, true);
  }
});

$("clearKey").addEventListener("click", async () => {
  await saveAnswerSettings({ apiKey: "", model: "" });
  settings = await loadAnswerSettings();
  render();
  const fallback = targetName((await loadSettings()).fallback);
  say(
    keyStatus,
    builtin === AVAILABLE || builtin === DOWNLOADABLE || builtin === DOWNLOADING
      ? "Key cleared. Answer here uses Chrome's built-in AI now."
      : `Key cleared. Answer here sends questions to ${fallback} until a key is set.`,
  );
});

async function hasApiAccess() {
  if (!globalThis.chrome?.permissions?.contains) return true;
  try {
    return await chrome.permissions.contains({ origins: [API_ORIGIN] });
  } catch {
    return false;
  }
}

async function paintApiAccess() {
  $("apiAccessHint").hidden = await hasApiAccess();
}

await paintApiAccess();

async function requestApiAccess() {
  if (!globalThis.chrome?.permissions?.request) return true; // plain-file dev
  try {
    if (await chrome.permissions.contains({ origins: [API_ORIGIN] })) return true;
    return await chrome.permissions.request({ origins: [API_ORIGIN] });
  } catch {
    return false;
  }
}

// A key saved by an earlier version never got a model. Pick one now, quietly,
// rather than leave Answer here dead until someone finds the Model card.
if (settings.apiKey && !settings.model && (await hasApiAccess())) {
  checkKey(settings.apiKey)
    .then(async ({ models, model }) => {
      if (!model) return;
      await saveAnswerSettings({ model });
      settings = await loadAnswerSettings();
      render();
      setModelOptions(models, model);
      say(modelStatus, `Picked ${model} for you. Change it here any time.`);
    })
    .catch(() => {});
}

// --- Chrome's built-in AI --------------------------------------------------------

paintBuiltin();

function paintBuiltin() {
  const status = $("builtinStatus");
  const button = $("prepareBuiltin");
  button.hidden = !(builtin === DOWNLOADABLE || builtin === DOWNLOADING);
  button.textContent = builtin === DOWNLOADING ? "Show download progress" : "Download it now";
  status.textContent =
    builtin === AVAILABLE
      ? "Ready on this computer. Answers are made here — free, and nothing is sent anywhere."
      : builtin === DOWNLOADABLE
        ? "This computer can run it after a one-time download by Chrome. Download it now so the first answer doesn't wait, or let the first question start it."
        : builtin === DOWNLOADING
          ? "Chrome is downloading it now."
          : "Not available here. It needs a recent desktop Chrome on a computer with plenty of memory and about 22 GB of free disk space. A key, below, works anywhere.";
}

$("prepareBuiltin").addEventListener("click", async () => {
  const progress = $("builtinProgress");
  const button = $("prepareBuiltin");
  button.disabled = true;
  say(progress, "Starting the download…");
  try {
    // Inside the click: Chrome only starts the download for a user gesture.
    const session = await openSession({
      onProgress: (loaded) => say(progress, `Downloading Chrome's built-in AI — ${percent(loaded)}%`),
    });
    session.destroy?.();
    builtin = await builtinAvailability();
    say(progress, "Downloaded. Answer here can use it now.");
  } catch (error) {
    say(progress, describeBuiltinFailure(error), true);
  } finally {
    button.disabled = false;
    paintBuiltin();
    render();
  }
});

// --- the model ----------------------------------------------------------------

function setModelOptions(ids, selected) {
  modelSelect.replaceChildren();
  const all = ids.length ? ids : selected ? [selected] : [];

  for (const id of all) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id; // an id from the API is text, not markup
    if (id === selected) option.selected = true;
    modelSelect.append(option);
  }
  if (!all.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Refresh the list to choose a model";
    modelSelect.append(option);
  }
}

modelSelect.addEventListener("change", async () => {
  await saveAnswerSettings({ model: modelSelect.value });
  settings = await loadAnswerSettings();
  say(modelStatus, `Answers will use ${modelSelect.value}.`);
});

$("refreshModels").addEventListener("click", async () => {
  say(modelStatus, "Loading…");
  try {
    const models = await listModels(settings.apiKey);
    if (!models.includes(settings.model)) {
      const picked = pickModel(models);
      if (picked) {
        await saveAnswerSettings({ model: picked });
        settings = await loadAnswerSettings();
        render();
      }
    }
    setModelOptions(models, settings.model);
    say(modelStatus, `${models.length} chat model${models.length === 1 ? "" : "s"} available.`);
  } catch (error) {
    say(modelStatus, error.message, true);
  }
});

// --- the budget ---------------------------------------------------------------

$("saveBudget").addEventListener("click", async () => {
  await saveAnswerSettings({
    tokenCap: $("tokenCap").value,
    rateInPerM: $("rateIn").value,
    rateOutPerM: $("rateOut").value,
  });
  settings = await loadAnswerSettings();
  say($("budgetStatus"), "Budget saved.");
  showUsage();
});

async function showUsage() {
  const spend = await readSpend();
  const cost = estimateCost(
    { prompt: spend.tokens, completion: 0 },
    { inputPerM: settings.rateInPerM },
  );

  const cap = settings.tokenCap > 0 ? ` of ${settings.tokenCap.toLocaleString()}` : " (no limit set)";
  const money = cost === null ? "" : ` — about $${cost.toFixed(4)} at your input rate`;
  $("usage").textContent = `Today: ${spend.tokens.toLocaleString()} tokens${cap}${money}.`;
}


// --- permissions -------------------------------------------------------------------

/**
 * What just happened to each row, by grant id.
 *
 * Kept outside renderGrants() because the render is how a toggle reports back,
 * and a re-render would otherwise wipe the one thing worth saying.
 *
 * This exists because of the bug it fixes: Chrome asks for an optional
 * permission in a popup at the *top* of the window, with **Deny** focused by
 * default — and the Permissions panel is at the bottom of a long page. Miss
 * that popup, or press Enter, and the row re-rendered byte-identical: still
 * Off, still "Turn on", not a word about why. Verified in a headed browser —
 * the toggle works perfectly when Allow is clicked. Silence was the whole bug.
 */
const grantNotes = new Map();

const DENIED_NOTE =
  "Still off. Chrome asks for this in a popup at the top of the window, and Deny is its default — " +
  "if you missed it or pressed Enter, choose Turn on again and look up there.";

await renderGrants();

async function renderGrants() {
  const list = $("grants");
  list.replaceChildren();
  let on = 0;

  for (const entry of GRANTS) {
    const granted = await isGranted(entry);
    if (granted) on += 1;

    const item = document.createElement("li");
    item.className = "grant";
    item.dataset.grant = entry.id;
    item.classList.toggle("isOn", granted);

    const head = document.createElement("div");
    head.className = "grantHead";

    const title = document.createElement("span");
    title.className = "grantTitle";
    title.textContent = entry.title;

    const state = document.createElement("span");
    state.className = "grantState";
    state.textContent = granted ? "On" : "Off";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "grantToggle";
    button.textContent = granted ? "Turn off" : "Turn on";
    button.setAttribute("aria-label", `${granted ? "Turn off" : "Turn on"} ${entry.title}`);
    button.addEventListener("click", async () => {
      // Both inside the click: Chrome refuses a permission request without a
      // user gesture, and refuses it silently.
      if (granted) {
        const removed = await revoke(entry);
        grantNotes.set(entry.id, removed ? "" : "Chrome would not turn that off. Try again.");
      } else {
        const allowed = await grant(entry);
        grantNotes.set(entry.id, allowed ? "" : DENIED_NOTE);
      }
      await renderGrants();
    });

    head.append(title, state, button);

    const why = document.createElement("p");
    why.className = "grantWhy";
    why.textContent = entry.why;

    item.append(head, why);

    const note = grantNotes.get(entry.id);
    if (note) {
      const said = document.createElement("p");
      said.className = "grantNote";
      said.textContent = note;
      // Announced, not just painted: someone who cannot see the popup appear
      // is exactly who most needs to be told it did.
      said.setAttribute("role", "status");
      item.append(said);
    }

    if (entry.cost) {
      const cost = document.createElement("p");
      cost.className = "grantCost";
      cost.textContent = entry.cost;
      item.append(cost);
    }

    list.append(item);
  }

  setState("statePermissions", `${on} of ${GRANTS.length} on`, on > 0);
}

// --- which section you are looking at ------------------------------------------------

/**
 * Lights the nav link for the section currently on screen.
 *
 * An IntersectionObserver rather than a scroll listener, for the reason
 * `docs/BRAND.md` gives about the site: a scroll handler runs on every frame to
 * compute something that changes rarely.
 *
 * **It only ever adds highlighting.** If the observer never reports — no support,
 * a hidden page, a browser that behaves differently — every link stays plain and
 * every link still works, because they are ordinary anchors. Nothing here may
 * hide or disable anything.
 */
{
  const links = [...document.querySelectorAll(".navLink")];
  const byId = new Map(links.map((link) => [link.getAttribute("href").slice(1), link]));
  const sections = [...byId.keys()].map((id) => $(id)).filter(Boolean);

  if (globalThis.IntersectionObserver && sections.length) {
    const onScreen = new Set();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onScreen.add(entry.target.id);
          else onScreen.delete(entry.target.id);
        }

        // The topmost visible section wins, so scrolling down moves the
        // highlight one step at a time rather than jumping to whichever
        // boundary happened to be crossed last.
        const here = sections.find((section) => onScreen.has(section.id));
        for (const [id, link] of byId) link.classList.toggle("isHere", Boolean(here) && id === here.id);
      },
      // A band across the upper half: a section counts as "here" once its top
      // reaches the middle of the window, which is where the eye is.
      { rootMargin: "-10% 0px -55% 0px" },
    );

    for (const section of sections) observer.observe(section);
  }
}
