import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO, GOOGLE, CHATGPT, CLAUDE, PERPLEXITY } from "../extension/src/router.js";
import { loadSettings, saveMode } from "../extension/src/settings.js";

test("fresh install defaults to Auto (Chrome default search engine)", async () => {
  const settings = await loadSettings();
  assert.equal(settings.mode, AUTO);
  assert.equal(settings.nudgeDismissed, false);
});

test("an explicit destination in storage is preserved", async () => {
  await saveMode(GOOGLE);
  assert.equal((await loadSettings()).mode, GOOGLE);
  await saveMode(CHATGPT);
  assert.equal((await loadSettings()).mode, CHATGPT);
});

test("a new profile is asked once, and its answer sticks", async () => {
  const { recordInstall, finishOnboarding } = await import("../extension/src/settings.js");
  await recordInstall("install");
  assert.equal((await loadSettings()).onboarding, "pending");
  assert.equal(await finishOnboarding(CLAUDE), CLAUDE);
  const after = await loadSettings();
  assert.equal(after.mode, CLAUDE);
  assert.equal(after.fallback, CLAUDE);
  assert.equal(after.onboarding, "done");
  // A later update does not re-ask.
  await recordInstall("update");
  assert.equal((await loadSettings()).onboarding, "done");
});

test("the Answer-here fallback is ChatGPT unless set, and only ever a hand-off", async () => {
  const { saveFallback } = await import("../extension/src/settings.js");
  await saveFallback(AUTO);
  assert.equal((await loadSettings()).fallback, CHATGPT);
  await saveFallback(PERPLEXITY);
  assert.equal((await loadSettings()).fallback, PERPLEXITY);
});
