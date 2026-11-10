import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, parseInline, plainText } from "../extension/src/markdown.js";

const types = (blocks) => blocks.map((b) => b.type);

test("paragraphs split on blank lines and keep their line breaks", () => {
  const blocks = parse("First line\nsecond line\n\nNext paragraph");
  assert.deepEqual(types(blocks), ["paragraph", "paragraph"]);
  assert.deepEqual(blocks[0].lines, ["First line", "second line"]);
});

test("headings, rules and quotes", () => {
  const blocks = parse("## Steps ##\n---\n> quoted\n> more");
  assert.deepEqual(types(blocks), ["heading", "rule", "quote"]);
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[0].text, "Steps");
  assert.deepEqual(blocks[2].lines, ["quoted", "more"]);
});

test("bulleted and numbered lists, with their start number", () => {
  const blocks = parse("- one\n- two\n\n3. three\n4. four");
  assert.deepEqual(types(blocks), ["list", "list"]);
  assert.deepEqual(blocks[0].items, ["one", "two"]);
  assert.equal(blocks[1].ordered, true);
  assert.equal(blocks[1].start, 3);
});

test("a loose list survives a blank line between items", () => {
  const blocks = parse("1. one\n\n2. two");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].items, ["one", "two"]);
});

test("an indented line continues a list item", () => {
  assert.deepEqual(parse("- item\n  more of it")[0].items, ["item\nmore of it"]);
});

test("fenced code keeps its text verbatim, Markdown and all", () => {
  const blocks = parse("```js\nconst a = **b**;\n# not a heading\n```\nafter");
  assert.deepEqual(types(blocks), ["code", "paragraph"]);
  assert.equal(blocks[0].lang, "js");
  assert.equal(blocks[0].text, "const a = **b**;\n# not a heading");
});

test("an unclosed fence mid-stream is still code", () => {
  const blocks = parse("Here:\n```\nline one");
  assert.deepEqual(types(blocks), ["paragraph", "code"]);
  assert.equal(blocks[1].text, "line one");
});

test("tables need a header rule, and read their cells", () => {
  const blocks = parse("| Bow | Draw |\n|---|:--:|\n| Long | 50 lb |\n| Recurve | 35 lb |");
  assert.deepEqual(types(blocks), ["table"]);
  assert.deepEqual(blocks[0].header, ["Bow", "Draw"]);
  assert.deepEqual(blocks[0].rows, [["Long", "50 lb"], ["Recurve", "35 lb"]]);
  assert.deepEqual(types(parse("a | b\nnot a rule")), ["paragraph"]);
});

test("inline: bold, italic, code and links", () => {
  assert.deepEqual(parseInline("a **b** _c_ `d`"), [
    { type: "text", text: "a " },
    { type: "strong", children: [{ type: "text", text: "b" }] },
    { type: "text", text: " " },
    { type: "em", children: [{ type: "text", text: "c" }] },
    { type: "text", text: " " },
    { type: "code", text: "d" },
  ]);
  assert.deepEqual(parseInline("[docs](https://example.com/x)"), [
    { type: "link", href: "https://example.com/x", children: [{ type: "text", text: "docs" }] },
  ]);
});

test("only http(s) links become links; the rest stays text", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,x", "chrome://settings", "file:///etc/passwd"]) {
    const spans = parseInline(`[click](${href})`);
    assert.ok(!spans.some((s) => s.type === "link"), href);
    assert.deepEqual(spans, [{ type: "text", text: "click" }]);
  }
});

test("a link target may hold balanced parentheses", () => {
  assert.equal(parseInline("[Bow](https://en.wikipedia.org/wiki/Bow_(weapon))")[0].href, "https://en.wikipedia.org/wiki/Bow_(weapon)");
});

test("a bare http(s) URL is linked, without its trailing punctuation", () => {
  const spans = parseInline("See https://example.com/a.");
  assert.equal(spans[1].href, "https://example.com/a");
  assert.equal(spans.at(-1).text, ".");
});

test("snake_case, arithmetic and lone markers are not emphasis", () => {
  assert.deepEqual(parseInline("use snake_case_names"), [{ type: "text", text: "use snake_case_names" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
  assert.deepEqual(parseInline("**unclosed"), [{ type: "text", text: "**unclosed" }]);
});

test("backslash escapes are honoured", () => {
  assert.deepEqual(parseInline("\\*not em\\*"), [{ type: "text", text: "*not em*" }]);
});

test("line breaks inside a paragraph are kept", () => {
  assert.deepEqual(parseInline("a\nb"), [{ type: "text", text: "a" }, { type: "break" }, { type: "text", text: "b" }]);
});

test("plainText flattens the answer for copying", () => {
  assert.equal(plainText(parse("# Title\n\n- a\n- b\n\n```\nx\n```")), "Title\n\na\nb\n\nx");
});

test("parse is total", () => {
  for (const input of [undefined, null, "", "\n\n", "|", "```", "> ", "- ", "1."]) parse(input);
});
