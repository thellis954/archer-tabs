import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, deflateSync } from "node:zlib";
import {
  kindOf,
  extensionOf,
  looksBinary,
  decodeEntities,
  stripXml,
  unzip,
  wordText,
  sheetText,
  slidesText,
  sharedStrings,
  readRows,
  unescapePdf,
  pdfTextFromStream,
  pdfText,
  dataUrl,
  extract,
  MAX_TEXT_CHARS,
} from "../extension/src/extract.js";

// --- what kind of file is this ------------------------------------------------------

test("extensionOf takes the last dot, and copes with none", () => {
  assert.equal(extensionOf("notes.md"), "md");
  assert.equal(extensionOf("archive.tar.gz"), "gz");
  assert.equal(extensionOf("Makefile"), "");
  assert.equal(extensionOf("PHOTO.JPG"), "jpg");
});

test("kindOf routes the formats people actually attach", () => {
  assert.equal(kindOf("report.pdf", "application/pdf"), "pdf");
  assert.equal(kindOf("report.pdf", ""), "pdf");
  assert.equal(kindOf("brief.docx", ""), "word");
  assert.equal(kindOf("budget.xlsx", ""), "sheet");
  assert.equal(kindOf("deck.pptx", ""), "slides");
  assert.equal(kindOf("shot.png", "image/png"), "image");
  assert.equal(kindOf("shot.JPEG", ""), "image");
  assert.equal(kindOf("notes.md", ""), "text");
  assert.equal(kindOf("script.py", ""), "text");
});

test("kindOf trusts the extension over a wrong or missing MIME type", () => {
  // Chrome reports octet-stream for plenty of things it has no mapping for.
  assert.equal(kindOf("budget.xlsx", "application/octet-stream"), "sheet");
  assert.equal(kindOf("notes.md", "application/octet-stream"), "text");
  // No extension at all is a Makefile or a LICENSE far more often than a binary.
  assert.equal(kindOf("Makefile", ""), "text");
  assert.equal(kindOf("LICENSE", ""), "text");
  // A type with no extension to contradict it is still believed.
  assert.equal(kindOf("blob", "text/plain"), "text");
});

test("kindOf refuses images no vision model takes", () => {
  assert.equal(kindOf("scan.tiff", "image/tiff"), "binary");
  assert.equal(kindOf("clip.mp4", "video/mp4"), "binary");
});

test("looksBinary finds NUL in the head, not past it", () => {
  assert.equal(looksBinary(new Uint8Array([104, 105])), false);
  assert.equal(looksBinary(new Uint8Array([104, 0, 105])), true);
  // Beyond the 4 KB head, a stray NUL does not condemn the file.
  const late = new Uint8Array(5000);
  late.fill(65);
  late[4500] = 0;
  assert.equal(looksBinary(late), false);
});

// --- xml ---------------------------------------------------------------------------

test("decodeEntities handles named, decimal and hex forms", () => {
  assert.equal(decodeEntities("a &amp; b"), "a & b");
  assert.equal(decodeEntities("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeEntities("&#65;&#x42;"), "AB");
  // Something that is not an entity is left exactly as it was.
  assert.equal(decodeEntities("100 &widgets;"), "100 &widgets;");
});

test("stripXml keeps paragraph boundaries rather than running text together", () => {
  const xml = "<w:p><w:r><w:t>First line</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p>";
  assert.equal(stripXml(xml).trim(), "First line\nSecond line");
});

test("stripXml turns tabs and breaks into their characters", () => {
  assert.equal(stripXml("<w:t>a</w:t><w:tab/><w:t>b</w:t>"), "a\tb");
  assert.equal(stripXml("<w:t>a</w:t><w:br/><w:t>b</w:t>"), "a\nb");
});

// --- zip ---------------------------------------------------------------------------

/** A minimal but real zip, so unzip() is tested against bytes and not a stub. */
function makeZip(entries, { deflate = true } = {}) {
  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(content);
    const body = deflate ? new Uint8Array(deflateRawSync(Buffer.from(raw))) : raw;
    const method = deflate ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x0403_4b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    locals.push(local);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x0201_4b50, true);
    dv.setUint16(10, method, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, raw.length, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length;
  }

  const centralSize = central.reduce((n, d) => n + d.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x0605_4b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...locals, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test("unzip reads deflated entries", async () => {
  const parts = await unzip(makeZip({ "a.txt": "hello", "b/c.xml": "<x>y</x>" }));
  assert.deepEqual([...parts.keys()].sort(), ["a.txt", "b/c.xml"]);
  assert.equal(new TextDecoder().decode(parts.get("a.txt")), "hello");
});

test("unzip reads stored (uncompressed) entries too", async () => {
  const parts = await unzip(makeZip({ "a.txt": "hello" }, { deflate: false }));
  assert.equal(new TextDecoder().decode(parts.get("a.txt")), "hello");
});

test("unzip rejects something that is not a zip", async () => {
  await assert.rejects(() => unzip(new TextEncoder().encode("just some text")), /not a zip/);
});

// --- the office formats ---------------------------------------------------------------

test("wordText reads the body part of a .docx", async () => {
  const parts = await unzip(
    makeZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        "<w:document><w:body><w:p><w:r><w:t>Quarterly review</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Revenue rose 4%.</w:t></w:r></w:p></w:body></w:document>",
    }),
  );
  assert.equal(wordText(parts), "Quarterly review\nRevenue rose 4%.");
});

test("wordText is empty rather than throwing when the body part is missing", async () => {
  const parts = await unzip(makeZip({ "word/settings.xml": "<w:settings/>" }));
  assert.equal(wordText(parts), "");
});

test("sharedStrings flattens each entry to one line", () => {
  const xml = "<sst><si><t>Region</t></si><si><r><t>North</t></r><r><t>East</t></r></si></sst>";
  assert.deepEqual(sharedStrings(xml), ["Region", "NorthEast"]);
});

test("readRows rebuilds the grid, resolving shared strings and keeping numbers", () => {
  const xml =
    '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>';
  assert.deepEqual(readRows(xml, ["Region", "Revenue", "North"]), ["Region\tRevenue", "North\t1200"]);
});

test("readRows drops rows that are only empty cells", () => {
  assert.deepEqual(readRows('<row><c r="A1"/></row><row><c r="A2"><v>7</v></c></row>'), ["7"]);
});

test("sheetText renders a whole workbook as tab-separated rows", async () => {
  const parts = await unzip(
    makeZip({
      "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Rope</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
        '<row><c t="s"><v>2</v></c><c><v>19.5</v></c></row></sheetData></worksheet>',
    }),
  );
  assert.equal(sheetText(parts), "--- sheet1 ---\nItem\tCost\nRope\t19.5");
});

test("slidesText orders slides numerically, not by string", async () => {
  const slide = (text) => `<p:sld><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sld>`;
  const parts = await unzip(
    makeZip({
      "ppt/slides/slide10.xml": slide("Tenth"),
      "ppt/slides/slide2.xml": slide("Second"),
      "ppt/slides/slide1.xml": slide("First"),
    }),
  );
  const text = slidesText(parts);
  assert.match(text, /--- slide 1 ---\nFirst/);
  assert.ok(text.indexOf("Second") < text.indexOf("Tenth"), "slide2 must come before slide10");
});

// --- pdf ---------------------------------------------------------------------------

test("unescapePdf handles the C escapes, octal, and line continuations", () => {
  assert.equal(unescapePdf(String.raw`a\(b\)c`), "a(b)c");
  assert.equal(unescapePdf(String.raw`a\nb`), "a\nb");
  assert.equal(unescapePdf(String.raw`\101\102`), "AB");
  assert.equal(unescapePdf("one\\\ntwo"), "onetwo");
  assert.equal(unescapePdf(String.raw`a\\b`), "a\\b");
});

test("pdfTextFromStream pulls literal strings out of Tj and TJ", () => {
  const content = "BT /F1 12 Tf (Hello) Tj T* [(wor) -20 (ld)] TJ ET";
  assert.equal(pdfTextFromStream(content).trim(), "Hello\nworld");
});

test("pdfTextFromStream reads hex strings", () => {
  assert.equal(pdfTextFromStream("BT <48656C6C6F> Tj ET").trim(), "Hello");
});

test("pdfTextFromStream treats line movers as newlines", () => {
  const content = "BT (first) Tj 0 -14 Td (second) Tj ET";
  assert.equal(pdfTextFromStream(content).trim(), "first\nsecond");
});

/** A PDF is a stream between the markers; that is all pdfText looks for. */
function makePdf(content, { compress = true } = {}) {
  const body = compress ? deflateSync(Buffer.from(content)) : Buffer.from(content);
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${body.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`);
  const tail = Buffer.from("\nendstream\nendobj\n%%EOF\n");
  return new Uint8Array(Buffer.concat([head, body, tail]));
}

test("pdfText inflates a FlateDecode stream and reads its text", async () => {
  const text = await pdfText(makePdf("BT (Invoice 4102) Tj T* (Total due: 90.00) Tj ET"));
  assert.match(text, /Invoice 4102/);
  assert.match(text, /Total due: 90\.00/);
});

test("pdfText reads an uncompressed stream", async () => {
  const text = await pdfText(makePdf("BT (Plain text pdf) Tj ET", { compress: false }));
  assert.match(text, /Plain text pdf/);
});

test("pdfText returns nothing for a PDF whose streams are images", async () => {
  const bytes = new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj\n<< /Filter /DCTDecode /Length 4 >>\nstream\n\nendstream\n%%EOF",
  );
  assert.equal(await pdfText(bytes), "");
});

// --- data urls -------------------------------------------------------------------------

test("dataUrl encodes bytes as base64 with the right prefix", () => {
  assert.equal(dataUrl(new Uint8Array([72, 105]), "image/png"), "data:image/png;base64,SGk=");
});

test("dataUrl survives a payload bigger than one apply() chunk", () => {
  const big = new Uint8Array(0x8000 * 2 + 5).fill(65);
  const url = dataUrl(big, "image/png");
  assert.equal(atob(url.split(",")[1]).length, big.length);
});

// --- the one entry point ----------------------------------------------------------------

/** Stands in for a DOM File, which node does not have. */
const asFile = (name, bytes, type = "") => ({
  name,
  type,
  size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

test("extract reads a text file", async () => {
  const out = await extract(asFile("notes.md", new TextEncoder().encode("  # Title  ")));
  assert.equal(out.kind, "text");
  assert.equal(out.text, "# Title");
  assert.equal(out.note, undefined);
});

test("extract reads a .docx into text", async () => {
  const zip = makeZip({ "word/document.xml": "<w:p><w:r><w:t>Contract terms</w:t></w:r></w:p>" });
  const out = await extract(asFile("contract.docx", zip));
  assert.equal(out.kind, "word");
  assert.equal(out.text, "Contract terms");
});

test("extract reads an .xlsx into rows", async () => {
  const zip = makeZip({
    "xl/sharedStrings.xml": "<sst><si><t>Total</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row></sheetData>',
  });
  const out = await extract(asFile("budget.xlsx", zip));
  assert.equal(out.kind, "sheet");
  assert.match(out.text, /Total\t42/);
});

test("extract turns an image into a data URL and no text", async () => {
  const out = await extract(asFile("shot.png", new Uint8Array([137, 80, 78, 71]), "image/png"));
  assert.equal(out.kind, "image");
  assert.equal(out.text, "");
  assert.match(out.dataUrl, /^data:image\/png;base64,/);
});

test("extract says so rather than attaching an empty scan", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Filter /DCTDecode >>\nstream\nxx\nendstream\n%%EOF");
  const out = await extract(asFile("scan.pdf", bytes, "application/pdf"));
  assert.equal(out.text, "");
  assert.match(out.note, /scan/);
});

test("extract points at re-saving when handed a legacy .doc", async () => {
  // The old binary format is not a zip, so unzip throws and the note has to be
  // the useful thing to say next rather than the exception. Classifying .doc as
  // an anonymous binary would lose that advice entirely, which is why the legacy
  // extensions are routed to the Office path they are going to fail.
  assert.equal(kindOf("old.doc", ""), "word");
  const out = await extract(asFile("old.doc", new TextEncoder().encode("\u00d0\u00cf\u00e0 not a zip")));
  assert.equal(out.text, "");
  assert.match(out.note, /re-save it as \.docx/);
});

test("...and names the right modern format for each legacy one", async () => {
  const stale = new TextEncoder().encode("\u00d0\u00cf\u00e0 not a zip");
  assert.match((await extract(asFile("old.xls", stale))).note, /\.xlsx/);
  assert.match((await extract(asFile("old.ppt", stale))).note, /\.pptx/);
});

test("extract calls a renamed binary what it is", async () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x00, 0x03]);
  const out = await extract(asFile("weird.txt", bytes));
  assert.equal(out.kind, "binary");
  assert.equal(out.text, "");
  assert.match(out.note, /not readable as text/);
});

test("extract never throws for a format it does not know", async () => {
  const out = await extract(asFile("clip.mp4", new Uint8Array([1, 2, 3]), "video/mp4"));
  assert.equal(out.kind, "binary");
  assert.equal(out.text, "");
  assert.ok(out.note);
});

test("extract clamps a file that is more corpus than context", async () => {
  const huge = new TextEncoder().encode("x".repeat(MAX_TEXT_CHARS + 5000));
  const out = await extract(asFile("huge.txt", huge));
  assert.equal(out.text.length, MAX_TEXT_CHARS);
});

test("extract always reports the name and size it was given", async () => {
  const out = await extract(asFile("report.pdf", makePdf("BT (hi) Tj ET"), "application/pdf"));
  assert.equal(out.name, "report.pdf");
  assert.ok(out.size > 0);
});
