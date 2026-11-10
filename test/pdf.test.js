import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  Lexer,
  parseValue,
  parseCMap,
  decodeWithCMap,
  pdfTextFromStream,
  pdfText,
  looksGarbled,
} from "../extension/src/pdf.js";

const latin1 = (s) => Buffer.from(s, "latin1");

/**
 * A PDF from numbered objects. Each is a dictionary string, or
 * `{ dict, stream }` for a stream object; `stream` is bytes or a string.
 * `length` overrides how /Length is written — a number, or "ref" to write it
 * as an indirect object placed after the stream, the way LibreOffice does.
 */
function buildPdf(objects, { length = "direct" } = {}) {
  const parts = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let extra = 1000;
  const trailing = [];
  for (const [id, body] of Object.entries(objects)) {
    if (typeof body === "string") {
      parts.push(latin1(`${id} 0 obj\n${body}\nendobj\n`));
      continue;
    }
    const data = typeof body.stream === "string" ? latin1(body.stream) : Buffer.from(body.stream);
    let lengthEntry = `/Length ${data.length}`;
    if (length === "ref") {
      lengthEntry = `/Length ${extra} 0 R`;
      trailing.push(`${extra} 0 obj\n${data.length}\nendobj\n`);
      extra++;
    }
    parts.push(latin1(`${id} 0 obj\n<<${lengthEntry} ${body.dict}>>\nstream\n`), data, latin1("\nendstream\nendobj\n"));
    parts.push(latin1(trailing.splice(0).join("")));
  }
  parts.push(latin1("trailer\n<</Root 1 0 R>>\n%%EOF\n"));
  return new Uint8Array(Buffer.concat(parts));
}

/** Two-byte glyph ids, written the way Chrome and Word write Identity-H text. */
const hexGlyphs = (ids) => "<" + ids.map((n) => n.toString(16).padStart(4, "0")).join("") + ">";

/** A one-page document whose only font is a subset TrueType under Identity-H. */
function identityPdf({ text, toUnicode = true, length } = {}) {
  const chars = [...new Set(text)];
  const glyph = (c) => chars.indexOf(c) + 3;
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    `${chars.length} beginbfchar`,
    ...chars.map((c) => `<${glyph(c).toString(16).padStart(4, "0")}> <${c.codePointAt(0).toString(16).padStart(4, "0")}>`),
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  // Bytes that look like text operators, to prove the font program is skipped.
  const fontProgram = deflateSync(latin1("BT (FONTPROGRAMJUNK) Tj ET \x00\x01\x02 glyf loca"));
  const content = `BT /F1 12 Tf 1 0 0 -1 50 700 Tm ${hexGlyphs([...text].map(glyph))} Tj ET`;
  return buildPdf(
    {
      1: "<</Type/Catalog/Pages 2 0 R>>",
      2: "<</Type/Pages/Kids[3 0 R]/Count 1>>",
      3: "<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
      4: { dict: "/Filter/FlateDecode", stream: deflateSync(latin1(content)) },
      5: `<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Memo/Encoding/Identity-H/DescendantFonts[6 0 R]${toUnicode ? "/ToUnicode 8 0 R" : ""}>>`,
      6: "<</Type/Font/Subtype/CIDFontType2/BaseFont/AAAAAA+Memo/DW 500/FontDescriptor 7 0 R>>",
      7: "<</Type/FontDescriptor/FontName/AAAAAA+Memo/FontFile2 9 0 R>>",
      8: { dict: "/Filter/FlateDecode", stream: deflateSync(latin1(cmap)) },
      9: { dict: "/Filter/FlateDecode/Length1 64", stream: fontProgram },
    },
    { length },
  );
}

test("parseValue reads nested dictionaries, arrays, names, refs and strings", () => {
  const value = parseValue(new Lexer("<</Type/Page/Kids[3 0 R 4 0 R]/Name/A#20B/T(hi)/H<6869>>>"));
  assert.equal(value.Type.name, "Page");
  assert.deepEqual(value.Kids.map((k) => k.ref), [3, 4]);
  assert.equal(value.Name.name, "A B");
  assert.equal(value.T.str, "hi");
  assert.equal(value.H.str, "hi");
});

test("parseCMap reads bfchar, bfrange and the array form of bfrange", () => {
  const cmap = parseCMap(
    [
      "1 begincodespacerange <0000> <FFFF> endcodespacerange",
      "1 beginbfchar <0003> <0048> endbfchar",
      "1 beginbfrange <0010> <0012> <0061> endbfrange",
      "1 beginbfrange <0020> <0021> [<00E9> <FB01>] endbfrange",
    ].join("\n"),
  );
  assert.equal(decodeWithCMap("\x00\x03\x00\x10\x00\x11\x00\x12", cmap), "Habc");
  assert.equal(decodeWithCMap("\x00\x20\x00\x21", cmap), "\u00e9\ufb01");
});

test("parseCMap maps a code to a surrogate pair", () => {
  const cmap = parseCMap("1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <01> <D83CDFAF> endbfchar");
  assert.equal(decodeWithCMap("\x01", cmap), "\u{1F3AF}");
});

test("pdfText reads Identity-H text through its ToUnicode map", async () => {
  const text = "Café in Zürich — “quotes” 12%";
  assert.equal(await pdfText(identityPdf({ text })), text);
});

test("pdfText never reads an embedded font program as text", async () => {
  const text = await pdfText(identityPdf({ text: "Invoice" }));
  assert.ok(!text.includes("FONTPROGRAMJUNK"), text);
});

test("pdfText resolves a /Length written as a reference after the stream", async () => {
  // Deflate output that happens to end in a newline byte would be corrupted by
  // trimming every EOL before endstream; the declared length must win.
  assert.equal(await pdfText(identityPdf({ text: "Quarterly memo", length: "ref" })), "Quarterly memo");
});

test("an Identity-H font with no ToUnicode map is flagged, not passed off as text", async () => {
  const text = await pdfText(identityPdf({ text: "Secret", toUnicode: false }));
  assert.ok(looksGarbled(text), JSON.stringify(text));
});

test("pdfText reads pages whose objects live in an object stream", async () => {
  const font = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  const page = "<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>";
  const header = `3 0 5 ${page.length + 1} `;
  const body = `${page} ${font}`;
  const pdf = buildPdf({
    1: "<</Type/Catalog/Pages 2 0 R>>",
    2: "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    4: { dict: "/Filter/FlateDecode", stream: deflateSync(latin1("BT /F1 12 Tf 50 700 Td (From an object stream) Tj ET")) },
    6: { dict: `/Type/ObjStm/N 2/First ${header.length}/Filter/FlateDecode`, stream: deflateSync(latin1(header + body)) },
  });
  assert.equal(await pdfText(pdf), "From an object stream");
});

test("pdfText reads text drawn inside a form XObject", async () => {
  const pdf = buildPdf({
    1: "<</Type/Catalog/Pages 2 0 R>>",
    2: "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    3: "<</Type/Page/Parent 2 0 R/Resources<</XObject<</X1 5 0 R>>>>/Contents 4 0 R>>",
    4: { dict: "", stream: "q /X1 Do Q" },
    5: { dict: "/Type/XObject/Subtype/Form/BBox[0 0 100 100]", stream: "BT 10 10 Td (Inside a form) Tj ET" },
  });
  assert.equal(await pdfText(pdf), "Inside a form");
});

test("pdfText follows the page order of the page tree, not the file order", async () => {
  const pdf = buildPdf({
    1: "<</Type/Catalog/Pages 2 0 R>>",
    2: "<</Type/Pages/Kids[5 0 R 3 0 R]/Count 2>>",
    3: "<</Type/Page/Parent 2 0 R/Contents 4 0 R>>",
    4: { dict: "", stream: "BT (second page) Tj ET" },
    5: "<</Type/Page/Parent 2 0 R/Contents 6 0 R>>",
    6: { dict: "", stream: "BT (first page) Tj ET" },
  });
  assert.equal(await pdfText(pdf), "first page\n\nsecond page");
});

test("a run placed past the end of the last one on the same line gets a space", () => {
  const widths = { F1: { decode: (s) => s, advance: (s) => s.length * 0.5 } };
  // "Arrows" is 6 × 0.5em × 10pt = 30pt wide; the next cell starts at 100.
  assert.equal(pdfTextFromStream("BT /F1 10 Tf 1 0 0 1 10 700 Tm (Arrows) Tj 1 0 0 1 100 700 Tm (120) Tj ET", { fonts: widths }), "Arrows 120");
  // A period placed right where the word ended is not a new word.
  assert.equal(pdfTextFromStream("BT /F1 10 Tf 10 700 Td (year) Tj 20 0 Td (.) Tj ET", { fonts: widths }), "year.");
});

test("pdfTextFromStream skips inline image data", () => {
  assert.equal(pdfTextFromStream("BI /W 2 /H 2 /BPC 8 ID \x00(Tj)\xff EI BT (after) Tj ET"), "after");
});

test("looksGarbled spots replacement characters and control bytes", () => {
  assert.equal(looksGarbled("A perfectly ordinary sentence, with punctuation."), false);
  assert.equal(looksGarbled("Café, naïve, résumé — “quoted” and 12%."), false);
  assert.equal(looksGarbled("\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD"), true);
  assert.equal(looksGarbled("\u00004\u0000X\u0000D\u0000U\u0000W"), true);
});

test("looksGarbled leaves an empty result to the empty-PDF path", () => {
  assert.equal(looksGarbled(""), false);
});
