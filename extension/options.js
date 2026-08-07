// The settings page. Its whole job is the API key, the model, and the budget.
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
} from "./src/settings.js";
import { listModels, estimateCost, API_ORIGIN } from "./src/answer.js";
import { variableNames } from "./src/library.js";
import { summarise, toMarkdown } from "./src/analytics.js";

const $ = (id) => document.getElementById(id);

const apiKey = $("apiKey");
const keyStatus = $("keyStatus");
const modelCard = $("modelCard");
const modelSelect = $("model");
const modelStatus = $("modelStatus");
const budgetCard = $("budgetCard");

let settings = await loadAnswerSettings();
render();

function render() {
  apiKey.value = settings.apiKey;
  $("tokenCap").value = settings.tokenCap ?? DEFAULT_TOKEN_CAP;
  $("rateIn").value = settings.rateInPerM || "";
  $("rateOut").value = settings.rateOutPerM || "";

  const hasKey = Boolean(settings.apiKey);
  modelCard.hidden = !hasKey;
  budgetCard.hidden = !hasKey;

  if (hasKey) {
    setModelOptions(settings.model ? [settings.model] : [], settings.model);
    showUsage();
  }
}

function say(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle("isError", isError);
}

// --- saved prompts --------------------------------------------------------------

const templateList = $("templates");

await renderTemplates();

async function renderTemplates() {
  const templates = await readLibrary();
  templateList.replaceChildren();

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
  if (!key) {
    say(keyStatus, "Paste a key first.", true);
    return;
  }

  // Must stay inside the click: Chrome refuses a permission request without a
  // user gesture. Reaching api.openai.com at all needs this origin, and asking
  // here means it is never in the install-time prompt.
  const granted = await requestApiAccess();
  if (!granted) {
    say(keyStatus, "Archer needs permission to reach api.openai.com before it can use a key.", true);
    return;
  }

  say(keyStatus, "Checking the key…");
  try {
    const models = await listModels(key);
    await saveAnswerSettings({ apiKey: key });
    settings = await loadAnswerSettings();
    modelCard.hidden = false;
    budgetCard.hidden = false;
    setModelOptions(models, settings.model);
    showUsage();
    say(keyStatus, `Saved. ${models.length} models available to this key.`);
  } catch (error) {
    // The key is not stored unless it worked — a saved key that 401s would be a
    // silent failure on the new tab page later.
    say(keyStatus, error.message, true);
  }
});

$("clearKey").addEventListener("click", async () => {
  await saveAnswerSettings({ apiKey: "", model: "" });
  settings = await loadAnswerSettings();
  apiKey.value = "";
  modelCard.hidden = true;
  budgetCard.hidden = true;
  say(keyStatus, "Key cleared. Answer mode falls back to your default search engine.");
});

async function requestApiAccess() {
  if (!globalThis.chrome?.permissions?.request) return true; // plain-file dev
  try {
    if (await chrome.permissions.contains({ origins: [API_ORIGIN] })) return true;
    return await chrome.permissions.request({ origins: [API_ORIGIN] });
  } catch {
    return false;
  }
}

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
    setModelOptions(models, settings.model);
    say(modelStatus, `${models.length} models available.`);
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
