import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO, GOOGLE, CHATGPT } from "../extension/src/router.js";
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
