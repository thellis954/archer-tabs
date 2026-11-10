import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO, CHATGPT, CLAUDE, PERPLEXITY, ANSWER_MODE, GOOGLE } from "../extension/src/router.js";
import { installPatch, choicePatch, needsPicker, CHOICES, DEFAULT_CHOICE, PENDING, DONE } from "../extension/src/onboarding.js";

test("a fresh install is asked where questions go", () => {
  assert.deepEqual(installPatch("install", {}), { onboarding: PENDING });
});

test("an update is never asked — existing users keep their settings", () => {
  for (const reason of ["update", "chrome_update", "shared_module_update"]) {
    assert.deepEqual(installPatch(reason, {}), { onboarding: DONE }, reason);
  }
});

test("an answered or pending question is left alone, whatever the event", () => {
  assert.equal(installPatch("install", { onboarding: DONE }), null);
  assert.equal(installPatch("update", { onboarding: PENDING }), null);
});

test("the picker shows only while the question is pending", () => {
  assert.equal(needsPicker({ onboarding: PENDING }), true);
  assert.equal(needsPicker({ onboarding: DONE }), false);
  assert.equal(needsPicker({ onboarding: "" }), false);
  assert.equal(needsPicker(undefined), false);
});

test("ChatGPT is the default and the first choice", () => {
  assert.equal(DEFAULT_CHOICE, CHATGPT);
  assert.deepEqual(CHOICES, [CHATGPT, CLAUDE, PERPLEXITY, ANSWER_MODE]);
});

test("a hand-off choice sets the mode and the Answer-here fallback together", () => {
  assert.deepEqual(choicePatch(CLAUDE), { mode: CLAUDE, fallbackMode: CLAUDE, onboarding: DONE });
});

test("Answer here keeps the existing fallback", () => {
  assert.deepEqual(choicePatch(ANSWER_MODE), { mode: ANSWER_MODE, onboarding: DONE });
});

test("Chrome's default engine is a choice too", () => {
  assert.deepEqual(choicePatch(AUTO), { mode: AUTO, onboarding: DONE });
});

test("anything unrecognised becomes the default", () => {
  for (const choice of [undefined, "", "nonsense", GOOGLE]) {
    assert.equal(choicePatch(choice).mode, CHATGPT, String(choice));
  }
});
