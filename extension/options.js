// The settings page. Its whole job is the API key, the model, and the budget.
//
// Every message here is set with textContent. Model ids come back from the API
// and the error strings come back from the API too — neither is ours to trust
// as markup.

import { loadAnswerSettings, saveAnswerSettings, readSpend, DEFAULT_TOKEN_CAP } from "./src/settings.js";
import { listModels, estimateCost, API_ORIGIN } from "./src/answer.js";

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
