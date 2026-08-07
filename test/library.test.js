import { test } from "node:test";
import assert from "node:assert/strict";
import {
  placeholders,
  variableNames,
  nextPlaceholder,
  fill,
  findTemplates,
  parseSlash,
} from "../extension/src/library.js";
import { summarise, toMarkdown } from "../extension/src/analytics.js";

// --- placeholders ------------------------------------------------------------

test("finds every blank, in order", () => {
  const found = placeholders("Translate {{text}} into {{language}}");
  assert.deepEqual(found.map((p) => p.name), ["text", "language"]);
  assert.equal(found[0].start, 10);
});

test("whitespace inside the braces is not part of the name", () => {
  assert.deepEqual(variableNames("{{ topic }}"), ["topic"]);
});

test("two blanks on one line stay separate", () => {
  assert.deepEqual(variableNames("{{a}} and {{b}}"), ["a", "b"]);
});

test("a repeated name is listed once", () => {
  assert.deepEqual(variableNames("{{x}} then {{x}} again"), ["x"]);
});

test("text with no blanks has none", () => {
  assert.deepEqual(placeholders("just a prompt"), []);
  assert.deepEqual(variableNames(""), []);
});

test("an unclosed brace is not a blank", () => {
  assert.deepEqual(placeholders("{{ unterminated"), []);
});

test("Tab walks the blanks left to right and then stops", () => {
  const template = "a {{one}} b {{two}}";
  const first = nextPlaceholder(template, 0);
  assert.equal(first.name, "one");

  const second = nextPlaceholder(template, first.end);
  assert.equal(second.name, "two");
  assert.equal(nextPlaceholder(template, second.end), null);
});

// --- filling -----------------------------------------------------------------

test("named values are substituted", () => {
  assert.equal(fill("Hi {{name}}", { name: "Tom" }), "Hi Tom");
});

test("an unanswered blank keeps its braces so it stays visible", () => {
  assert.equal(fill("Hi {{name}} from {{place}}", { name: "Tom" }), "Hi Tom from {{place}}");
});

// --- finding -----------------------------------------------------------------

const LIBRARY = [
  { id: "1", name: "summarise", text: "Summarise {{text}} in three bullets" },
  { id: "2", name: "translate", text: "Translate {{text}} into {{language}}" },
  { id: "3", name: "review", text: "Review this code for bugs" },
];

test("an empty query lists everything", () => {
  assert.equal(findTemplates(LIBRARY, "").length, 3);
});

test("a name prefix wins over a body hit", () => {
  // "review" is a name, and also appears inside no other body — but "re" is a
  // prefix of one name only, so that one must come first.
  assert.equal(findTemplates(LIBRARY, "re")[0].name, "review");
});

test("a body match still counts", () => {
  assert.deepEqual(findTemplates(LIBRARY, "bullets").map((t) => t.name), ["summarise"]);
});

test("no match is empty", () => {
  assert.deepEqual(findTemplates(LIBRARY, "zzz"), []);
});

// --- slash parsing -----------------------------------------------------------

test("a leading slash is a command", () => {
  assert.deepEqual(parseSlash("/trans"), { name: "trans", rest: "" });
  assert.deepEqual(parseSlash("/translate hello there"), { name: "translate", rest: "hello there" });
});

test("a bare slash lists everything", () => {
  assert.deepEqual(parseSlash("/"), { name: "", rest: "" });
});

test("a slash anywhere else is just text", () => {
  assert.equal(parseSlash("what is and/or"), null);
  assert.equal(parseSlash("example.com/path"), null);
  assert.equal(parseSlash(""), null);
});

// --- analytics ---------------------------------------------------------------

const DAY = 864e5;
const BASE = new Date(2026, 0, 5, 9, 0).getTime();

test("an empty log summarises to zeroes rather than NaN", () => {
  const summary = summarise([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.perDay, 0);
  assert.deepEqual(summary.topWords, []);
  assert.equal(summary.busiestHour, null);
});

test("counts, spans and averages", () => {
  const summary = summarise([
    { text: "one two three", at: BASE },
    { text: "four five", at: BASE + DAY },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.days, 1);
  assert.equal(summary.averageWords, 2.5);
});

test("stopwords and punctuation are stripped from the word counts", () => {
  const summary = summarise([
    { text: "what is the sourdough, and how?", at: BASE },
    { text: "sourdough again!", at: BASE },
  ]);
  const words = summary.topWords.map((w) => w.word);
  assert.equal(summary.topWords[0].word, "sourdough");
  assert.equal(summary.topWords[0].count, 2);
  for (const stop of ["what", "is", "the", "and", "how"]) {
    assert.ok(!words.includes(stop), `"${stop}" should not be counted`);
  }
});

test("the busiest hour is a local hour", () => {
  const summary = summarise([
    { text: "morning question", at: new Date(2026, 0, 5, 9, 30).getTime() },
    { text: "another morning one", at: new Date(2026, 0, 6, 9, 45).getTime() },
    { text: "evening one", at: new Date(2026, 0, 5, 21, 0).getTime() },
  ]);
  assert.equal(summary.busiestHour, 9);
  assert.equal(summary.byHour[9], 2);
  assert.equal(summary.byHour[21], 1);
});

// --- markdown export ---------------------------------------------------------

test("export is newest first, grouped by day", () => {
  const md = toMarkdown([
    { text: "older", at: new Date(2026, 0, 5, 9, 0).getTime() },
    { text: "newer", at: new Date(2026, 0, 6, 9, 0).getTime() },
  ]);
  assert.ok(md.indexOf("2026-01-06") < md.indexOf("2026-01-05"));
  assert.ok(md.includes("2 prompts."));
});

test("a prompt full of markdown does not become markdown", () => {
  // The reason prompts are fenced rather than inlined: this one would otherwise
  // turn into a heading, a list and a table in someone's notes.
  const md = toMarkdown([{ text: "# heading\n- item\n| a | b |", at: BASE }]);
  assert.ok(md.includes("  ```"), "the body is fenced");
  assert.ok(md.includes("  # heading"), "and indented inside the fence");
  assert.ok(!/^# heading$/m.test(md), "never at the start of a line");
});

test("an empty log still produces a valid document", () => {
  const md = toMarkdown([]);
  assert.ok(md.startsWith("# Archer — prompt history"));
  assert.ok(md.includes("0 prompts."));
});

test("entries with no timestamp are kept rather than dropped", () => {
  const md = toMarkdown([{ text: "undated thought" }]);
  assert.ok(md.includes("Undated"));
  assert.ok(md.includes("undated thought"));
});
