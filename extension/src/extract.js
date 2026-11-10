// Turning an attached file into text a model can read.
//
// The rule everywhere else in this repo applies here too: the decisions are
// pure functions, so they can be tested without a browser. The only browser API
// used is `DecompressionStream`, which node has as a global too — so every
// function in this file runs under `npm test`.
//
// What this deliberately does *not* do is pretend. A scanned PDF has no text in
// it, and no amount of parsing invents any; `extract()` says so rather than
// attaching an empty file and letting the model answer about nothing. Same for
// a format nothing here understands — the attachment still goes, carrying its
// name and type, with `note` explaining that the contents did not.

import { pdfText, looksGarbled } from "./pdf.js";

/** Beyond this, an attachment stops being context and starts being a corpus. */
export const MAX_TEXT_CHARS = 200_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "yaml", "yml",
  "xml", "svg", "html", "htm", "css", "scss", "js", "jsx", "mjs", "cjs", "ts",
  "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp",
  "cs", "php", "pl", "lua", "sh", "bash", "zsh", "sql", "toml", "ini", "cfg",
  "conf", "env", "log", "diff", "patch", "srt", "vtt", "tex", "bib", "gitignore",
]);

/**
 * Office formats, and the part of the package that holds the words.
 *
 * The legacy binary extensions are here too, even though they are not zips.
 * They fail `unzip` and land on the note telling you to re-save as .docx — the
 * one genuinely useful thing to say about a .doc, and something they would
 * never hear if they classified as an anonymous binary.
 */
const ZIP_DOCS = {
  docx: "word",
  docm: "word",
  doc: "word",
  xlsx: "sheet",
  xlsm: "sheet",
  xls: "sheet",
  pptx: "slides",
  pptm: "slides",
  ppt: "slides",
};

/** What a model can be shown directly, rather than read. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function extensionOf(name = "") {
  const at = String(name).lastIndexOf(".");
  return at === -1 ? "" : name.slice(at + 1).toLowerCase();
}

/**
 * How a file should be handled, from its name and the type the OS reported.
 *
 * The extension is trusted ahead of the MIME type because the type is often
 * empty or wrong — Chrome reports `application/octet-stream` for plenty of
 * things it has no mapping for — whereas the extension is what the user sees.
 *
 * @returns {"text"|"image"|"word"|"sheet"|"slides"|"pdf"|"binary"}
 */
export function kindOf(name = "", type = "") {
  const ext = extensionOf(name);
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  if (Object.hasOwn(ZIP_DOCS, ext)) return ZIP_DOCS[ext];
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (type.startsWith("image/")) return IMAGE_EXTENSIONS.has(type.slice(6)) ? "image" : "binary";
  if (type.startsWith("text/")) return "text";
  if (type === "application/json" || type === "application/xml") return "text";
  // No extension and no useful type: assume text and let the NUL check below
  // catch it if that was wrong. A file called `Makefile` or `LICENSE` is text.
  return ext === "" ? "text" : "binary";
}

/** The label a chip shows for each kind, so the user knows what actually went. */
export const KIND_LABEL = {
  text: "text",
  image: "image",
  word: "Word",
  sheet: "Excel",
  slides: "PowerPoint",
  pdf: "PDF",
  binary: "file",
};

// --- text ---------------------------------------------------------------------------

const decoder = new TextDecoder("utf-8");

/** True when the head of a buffer contains NUL — the reliable binary tell. */
export function looksBinary(bytes) {
  const head = bytes.subarray(0, 4096);
  return head.includes(0);
}

// --- zip --------------------------------------------------------------------------

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/**
 * The entries of a zip archive, by name.
 *
 * Reads the central directory rather than scanning for local headers, because
 * only the central directory is authoritative about sizes — a streamed zip
 * writes zero into the local header and puts the real values in a trailing
 * descriptor. Office writes exactly that kind of zip.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function unzip(bytes) {
  const out = new Map();

  // End of central directory: a 22-byte record whose signature sits at most
  // 65557 bytes from the end (the trailing comment may be up to 64 KB).
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 65_557);
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (u32(bytes, at) === 0x0605_4b50) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive");

  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);

  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== 0x0201_4b50) break;
    const method = u16(bytes, at + 10);
    const compressed = u32(bytes, at + 20);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const localAt = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // The local header repeats the name and extra field, at its own lengths.
    if (u32(bytes, localAt) === 0x0403_4b50) {
      const dataAt = localAt + 30 + u16(bytes, localAt + 26) + u16(bytes, localAt + 28);
      const raw = bytes.subarray(dataAt, dataAt + compressed);
      if (method === 0) out.set(name, raw);
      else if (method === 8) out.set(name, await inflate(raw, "deflate-raw"));
      // Anything else (bzip2, lzma) is vanishingly rare in Office files and is
      // simply absent from the map, which reads downstream as "no such part".
    }

    at += 46 + nameLength + extraLength + commentLength;
  }

  return out;
}

/** @param {"deflate"|"deflate-raw"} format */
async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- xml ---------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * The words out of an Office XML part.
 *
 * Tags become nothing, except the handful that mean "a line ended" — without
 * those every paragraph in a document runs into the next one and the result is
 * unreadable to a person and misleading to a model.
 */
export function stripXml(xml) {
  return decodeEntities(
    String(xml)
      .replace(/<(?:w|a):tab\b[^>]*\/?>/g, "\t")
      .replace(/<(?:w|a):br\b[^>]*\/?>/g, "\n")
      .replace(/<\/(?:w:p|a:p|w:tr|text:p)>/g, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

// --- the office formats -----------------------------------------------------------

/** Word: one part holds the body. Headers and footnotes are deliberately left out. */
export function wordText(parts) {
  const body = parts.get("word/document.xml");
  return body ? stripXml(decoder.decode(body)).trim() : "";
}

/** PowerPoint: one part per slide, in slide order rather than zip order. */
export function slidesText(parts) {
  const slides = [...parts.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  return slides
    .map((name, index) => `--- slide ${index + 1} ---\n${stripXml(decoder.decode(parts.get(name))).trim()}`)
    .join("\n\n")
    .trim();
}

const slideNumber = (name) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

/**
 * Excel, rendered as tab-separated rows.
 *
 * A spreadsheet's text lives in a shared string table and its cells hold
 * indexes into it, so the strings alone would be a bag of words with no rows
 * and no numbers. Rebuilding the grid is the only rendering that preserves what
 * a spreadsheet actually says.
 */
export function sheetText(parts) {
  const shared = sharedStrings(parts.get("xl/sharedStrings.xml"));

  const sheets = [...parts.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const out = [];
  for (const name of sheets) {
    const rows = readRows(decoder.decode(parts.get(name)), shared);
    if (rows.length) out.push(`--- ${name.replace(/^xl\/worksheets\//, "").replace(/\.xml$/, "")} ---\n${rows.join("\n")}`);
  }
  return out.join("\n\n").trim();
}

export function sharedStrings(part) {
  if (!part) return [];
  const xml = typeof part === "string" ? part : decoder.decode(part);
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => stripXml(m[1]).replace(/\n/g, " ").trim());
}

export function readRows(xml, shared = []) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const type = /\bt="([^"]*)"/.exec(cell[1])?.[1];
      if (type === "inlineStr") {
        cells.push(stripXml(cell[2]).trim());
        continue;
      }
      const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? "";
      if (type === "s") cells.push(shared[Number(value)] ?? "");
      else cells.push(decodeEntities(value));
    }
    // A row of nothing but empty cells is spreadsheet padding, not content.
    if (cells.some((c) => c !== "")) rows.push(cells.join("\t"));
  }
  return rows;
}

// --- pdf ----------------------------------------------------------------------------

// The PDF reader is big enough to be its own module; these are re-exported so
// everything an attachment can be is still reachable from one place.
export { unescapePdf, pdfTextFromStream, pdfText, looksGarbled } from "./pdf.js";

// --- the one entry point ------------------------------------------------------------

/**
 * Read a file into something sendable.
 *
 * @param {{name: string, type: string, size: number,
 *          arrayBuffer: () => Promise<ArrayBuffer>, text?: () => Promise<string>}} file
 * @returns {Promise<{name, size, kind, text: string, dataUrl?: string, note?: string}>}
 *
 * Never throws for a file it cannot understand: an attachment that fails is
 * still an attachment, and `note` is what the chip and the prompt say about it.
 */
export async function extract(file) {
  const kind = kindOf(file.name, file.type ?? "");
  const base = { name: file.name, size: file.size, kind };

  if (kind === "image") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { ...base, text: "", dataUrl: dataUrl(bytes, file.type || guessImageType(file.name)) };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (kind === "text") {
    if (looksBinary(bytes)) {
      return { ...base, kind: "binary", text: "", note: "not readable as text" };
    }
    return { ...base, text: clamp(decoder.decode(bytes)) };
  }

  if (kind === "pdf") {
    const text = await pdfText(bytes).catch(() => "");
    // A PDF of scans is a stack of images with no text layer. Saying so beats
    // attaching nothing and letting the model answer from the filename.
    if (!text) return { ...base, text: "", note: "no text layer — it looks like a scan" };
    // Text that decodes to noise is worse than none: a model will answer from it.
    if (looksGarbled(text)) {
      return { ...base, text: "", note: "its text is stored in a way Archer can't read — copy and paste the part you need" };
    }
    return { ...base, text: clamp(text) };
  }

  if (kind === "word" || kind === "sheet" || kind === "slides") {
    try {
      const parts = await unzip(bytes);
      const text = kind === "word" ? wordText(parts) : kind === "sheet" ? sheetText(parts) : slidesText(parts);
      if (!text) return { ...base, text: "", note: "no text found in it" };
      return { ...base, text: clamp(text) };
    } catch {
      // The old binary formats land here, and so does a corrupt file.
      const modern = { word: ".docx", sheet: ".xlsx", slides: ".pptx" }[kind];
      return {
        ...base,
        text: "",
        note: `could not be opened — if it is an older ${extensionOf(file.name) ? `.${extensionOf(file.name)}` : "Office"} file, re-save it as ${modern}`,
      };
    }
  }

  return { ...base, text: "", note: "contents not readable" };
}

const clamp = (text) => {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed;
};

function guessImageType(name) {
  const ext = extensionOf(name);
  return ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}`;
}

/** base64 without a dependency, and without blowing the stack on a big image. */
export function dataUrl(bytes, type) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}
