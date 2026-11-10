// Reading the words out of a PDF, without a PDF library.
//
// A PDF does not store text. It stores "draw glyph 0x0034 of font F4 here", and
// the fonts most PDFs use — everything Word, Google Docs, LibreOffice and
// Chrome's own "Save as PDF" write — are Identity-H: two-byte glyph ids that
// mean nothing on their own, plus a ToUnicode CMap that maps them back to
// characters. So reading a real PDF means walking from each page to the fonts
// it uses, and from each font to its CMap. It also means *not* reading the
// embedded font programs, which are the biggest streams in the file and come
// out as noise that looks just enough like text to be sent to a model.
//
// What still comes out as noise is refused by looksGarbled(), so the
// attachment says it could not be read instead of carrying garbage.
//
// Pure, apart from DecompressionStream — which node has too, so all of this
// runs under `npm test`.

/** Bytes to a string with one char per byte. TextDecoder("latin1") is really
    windows-1252, which remaps 0x80–0x9F and would corrupt glyph codes. */
export function binary(bytes) {
  let out = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return out;
}

const winAnsi = new TextDecoder("windows-1252");
const fromWinAnsi = (str) => winAnsi.decode(Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff));

async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Undo PDF string escaping: the C-style ones plus three-digit octal.
 *
 * A backslash before a newline is a line continuation and disappears, which is
 * why this cannot just be a table lookup.
 */
export function unescapePdf(text) {
  return text.replace(/\\(?:([0-7]{1,3})|(\r\n|[\r\n])|(.))/gs, (whole, octal, newline, char) => {
    if (octal !== undefined) return String.fromCharCode(parseInt(octal, 8) & 0xff);
    if (newline !== undefined) return "";
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[char] ?? char;
  });
}

function fromHex(hex) {
  let clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2) clean += "0";
  let out = "";
  for (let at = 0; at < clean.length; at += 2) out += String.fromCharCode(parseInt(clean.slice(at, at + 2), 16));
  return out;
}

// --- the lexer ----------------------------------------------------------------------

const isSpace = (c) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
const isDelimiter = (c) => "()<>[]{}/%".includes(c);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** Tokens out of PDF syntax, for both object dictionaries and content streams. */
export class Lexer {
  constructor(src, at = 0) {
    this.src = src;
    this.at = at;
  }

  skipSpace() {
    const { src } = this;
    while (this.at < src.length) {
      const c = src[this.at];
      if (isSpace(c)) this.at++;
      else if (c === "%") {
        while (this.at < src.length && src[this.at] !== "\n" && src[this.at] !== "\r") this.at++;
      } else break;
    }
  }

  next() {
    this.skipSpace();
    const { src } = this;
    if (this.at >= src.length) return null;
    const c = src[this.at];

    if (c === "(") return { t: "str", v: this.literal() };
    if (c === "<") {
      if (src[this.at + 1] === "<") {
        this.at += 2;
        return { t: "<<" };
      }
      const end = src.indexOf(">", this.at);
      const hex = src.slice(this.at + 1, end === -1 ? src.length : end);
      this.at = end === -1 ? src.length : end + 1;
      return { t: "str", v: fromHex(hex) };
    }
    if (c === ">") {
      this.at += src[this.at + 1] === ">" ? 2 : 1;
      return { t: ">>" };
    }
    if (c === "[" || c === "]" || c === "{" || c === "}") {
      this.at++;
      return { t: c };
    }
    if (c === ")") {
      this.at++;
      return this.next();
    }

    const from = c === "/" ? ++this.at : this.at;
    while (this.at < src.length && !isSpace(src[this.at]) && !isDelimiter(src[this.at])) this.at++;
    const word = src.slice(from, this.at);
    if (c === "/") return { t: "name", v: word.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    if (!word) {
      this.at++;
      return this.next();
    }
    if (NUMBER.test(word)) return { t: "num", v: Number(word) };
    return { t: "op", v: word };
  }

  /** A balanced-parenthesis string, escapes and all. */
  literal() {
    const { src } = this;
    const from = ++this.at;
    let depth = 1;
    while (this.at < src.length) {
      const c = src[this.at];
      if (c === "\\") this.at += 2;
      else {
        if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
        this.at++;
      }
    }
    const raw = src.slice(from, this.at);
    this.at++;
    return unescapePdf(raw);
  }
}

/**
 * One PDF value. Names are `{name}`, strings `{str}`, references `{ref}`, and a
 * dictionary is a prototype-free object so a key called `__proto__` in a hostile
 * file is just a key.
 */
export function parseValue(lex, token = lex.next()) {
  if (!token) return null;
  switch (token.t) {
    case "<<": {
      const dict = Object.create(null);
      for (;;) {
        const key = lex.next();
        if (!key || key.t === ">>") return dict;
        if (key.t !== "name") continue;
        const value = lex.next();
        if (!value || value.t === ">>") return dict;
        dict[key.v] = parseValue(lex, value);
      }
    }
    case "[": {
      const list = [];
      for (;;) {
        const item = lex.next();
        if (!item || item.t === "]") return list;
        list.push(parseValue(lex, item));
      }
    }
    case "num": {
      const save = lex.at;
      const generation = lex.next();
      if (generation?.t === "num") {
        const r = lex.next();
        if (r?.t === "op" && r.v === "R") return { ref: token.v };
      }
      lex.at = save;
      return token.v;
    }
    case "name":
      return { name: token.v };
    case "str":
      return { str: token.v };
    case "op":
      return token.v === "true" ? true : token.v === "false" ? false : null;
    default:
      return null;
  }
}

// --- the object table ----------------------------------------------------------------

/**
 * Every `n 0 obj` in the file, found by scanning rather than through the xref
 * table — the xref is the part of PDF most likely to be subtly broken in a file
 * that still opens fine everywhere.
 */
function readObjects(bytes, src) {
  const objects = new Map();
  let insideStreamUntil = 0;

  for (const match of src.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    // A match inside a binary stream is a coincidence, not an object.
    if (match.index < insideStreamUntil) continue;

    const lex = new Lexer(src, match.index + match[0].length);
    const value = parseValue(lex);
    const entry = { value };

    const keyword = lex.next();
    if (keyword?.t === "op" && keyword.v === "stream" && value && typeof value === "object") {
      let from = lex.at;
      if (src[from] === "\r") from++;
      if (src[from] === "\n") from++;

      let to = streamEnd(src, from, value.Length);
      if (to === -1) {
        to = src.indexOf("endstream", from);
        if (to === -1) continue;
        // Exactly one EOL is the delimiter. Compressed data can itself end in a
        // newline byte, so trimming every one of them corrupts the stream.
        if (bytes[to - 1] === 0x0a) to--;
        if (bytes[to - 1] === 0x0d) to--;
      }
      entry.raw = bytes.subarray(from, to);
      entry.from = from;
      insideStreamUntil = to;
    }
    objects.set(Number(match[1]), entry);
  }

  // A /Length written as a reference usually points at an object that comes
  // after the stream, so it can only be resolved once everything is read.
  for (const entry of objects.values()) {
    const length = entry.value?.Length;
    if (entry.raw && length && typeof length === "object" && "ref" in length) {
      const to = streamEnd(src, entry.from, objects.get(length.ref)?.value);
      if (to !== -1) entry.raw = bytes.subarray(entry.from, to);
    }
  }
  return objects;
}

/** Where a stream of a declared length ends, or -1 when the length is wrong. */
function streamEnd(src, from, length) {
  if (typeof length !== "number" || length < 0) return -1;
  let after = from + length;
  while (isSpace(src[after] ?? "")) after++;
  return src.startsWith("endstream", after) ? from + length : -1;
}

const nameOf = (value) => (value && typeof value === "object" && "name" in value ? value.name : null);

function resolve(objects, value, depth = 0) {
  while (value && typeof value === "object" && "ref" in value && depth++ < 16) {
    value = objects.get(value.ref)?.value ?? null;
  }
  return value;
}

/** The decoded bytes of a stream, or null when its encoding is not one this reads. */
function decodeStream(objects, entry) {
  if (!entry?.raw) return Promise.resolve(null);
  entry.decoded ??= (async () => {
    let filters = resolve(objects, entry.value.Filter);
    filters = Array.isArray(filters) ? filters.map((f) => nameOf(resolve(objects, f))) : filters ? [nameOf(filters)] : [];

    const params = resolve(objects, entry.value.DecodeParms);
    const predictor = (Array.isArray(params) ? resolve(objects, params[0]) : params)?.Predictor;
    if (predictor > 1) return null;

    let data = entry.raw;
    for (const filter of filters) {
      if (filter === "FlateDecode" || filter === "Fl") {
        data = await inflate(data, "deflate").catch(() => inflate(data, "deflate-raw").catch(() => null));
        if (!data) return null;
      } else if (filter === "ASCIIHexDecode" || filter === "AHx") {
        data = Uint8Array.from(fromHex(binary(data).split(">")[0]), (c) => c.charCodeAt(0));
      } else {
        return null;
      }
    }
    return data;
  })();
  return entry.decoded;
}

/** PDF 1.5 packs small objects — font dictionaries among them — into object streams. */
async function expandObjectStreams(objects) {
  const packed = [...objects.values()].filter((e) => e.raw && nameOf(e.value?.Type) === "ObjStm");
  for (const entry of packed) {
    const data = await decodeStream(objects, entry);
    if (!data) continue;
    const src = binary(data);
    const count = Number(entry.value.N) || 0;
    const first = Number(entry.value.First) || 0;

    const header = new Lexer(src);
    for (let i = 0; i < count; i++) {
      const num = header.next();
      const offset = header.next();
      if (num?.t !== "num" || offset?.t !== "num") break;
      if (objects.has(num.v)) continue;
      objects.set(num.v, { value: parseValue(new Lexer(src, first + offset.v)) });
    }
  }
}

/** The pages in reading order, each with the resources it inherits. */
function findPages(objects) {
  const pages = [];
  const seen = new Set();

  const walk = (node, inherited, depth) => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 64) return;
    seen.add(node);
    const resources = node.Resources ?? inherited;
    if (nameOf(node.Type) === "Page" || (!node.Kids && node.Contents)) {
      pages.push({ page: node, resources });
      return;
    }
    const kids = resolve(objects, node.Kids);
    if (Array.isArray(kids)) for (const kid of kids) walk(resolve(objects, kid), resources, depth + 1);
  };

  const catalog = [...objects.values()].map((e) => e.value).find((v) => nameOf(v?.Type) === "Catalog");
  if (catalog) walk(resolve(objects, catalog.Pages), null, 0);

  if (!pages.length) {
    for (const [, entry] of [...objects].sort((a, b) => a[0] - b[0])) {
      if (nameOf(entry.value?.Type) === "Page") pages.push({ page: entry.value, resources: entry.value.Resources });
    }
  }
  return pages;
}

// --- fonts ---------------------------------------------------------------------------

/**
 * A ToUnicode CMap, as the code widths it declares and what each code means.
 *
 * @returns {{ranges: Array<{width: number, lo: number, hi: number}>, maps: Map<number, Map<number, string>>}}
 */
export function parseCMap(text) {
  const ranges = [];
  const maps = new Map();
  const mapFor = (width) => maps.get(width) ?? maps.set(width, new Map()).get(width);
  const unicode = (hex) => {
    const clean = hex.replace(/\s+/g, "");
    if (clean.length <= 2) return String.fromCharCode(parseInt(clean || "0", 16));
    let out = "";
    for (let at = 0; at + 3 < clean.length; at += 4) out += String.fromCharCode(parseInt(clean.slice(at, at + 4), 16));
    return out;
  };

  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const [, lo, hi] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      ranges.push({ width: lo.length / 2, lo: parseInt(lo, 16), hi: parseInt(hi, 16) });
    }
  }

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]*)>/g)) {
      mapFor(src.length / 2).set(parseInt(src, 16), unicode(dst));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, dst, list] of block[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F\s]*)>|\[([^\]]*)\])/g,
    )) {
      const map = mapFor(lo.length / 2);
      const from = parseInt(lo, 16);
      const to = Math.min(parseInt(hi, 16), from + 0xffff);
      if (list !== undefined) {
        const targets = [...list.matchAll(/<([0-9a-fA-F\s]*)>/g)].map((m) => unicode(m[1]));
        targets.forEach((target, i) => from + i <= to && map.set(from + i, target));
        continue;
      }
      const base = unicode(dst);
      for (let code = from; code <= to; code++) {
        const step = code - from;
        map.set(code, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + step));
      }
    }
  }

  if (!ranges.length) for (const width of maps.keys()) ranges.push({ width, lo: 0, hi: 256 ** width - 1 });
  return { ranges, maps };
}

/** Turns a shown string into text through a parsed CMap. */
export function decodeWithCMap(str, cmap) {
  const widths = [...new Set(cmap.ranges.map((r) => r.width))].sort((a, b) => a - b);
  let out = "";
  for (let at = 0; at < str.length; ) {
    let width = widths.at(-1) ?? 1;
    let code = 0;
    for (const w of widths) {
      let candidate = 0;
      for (let i = 0; i < w; i++) candidate = candidate * 256 + (str.charCodeAt(at + i) & 0xff);
      if (cmap.ranges.some((r) => r.width === w && candidate >= r.lo && candidate <= r.hi)) {
        width = w;
        code = candidate;
        break;
      }
      code = candidate;
    }
    const hit = cmap.maps.get(width)?.get(code);
    out += hit ?? (width === 1 ? fromWinAnsi(str[at]) : "\uFFFD");
    at += width;
  }
  return out;
}

/** The handful of glyph names that carry most English text in a /Differences array. */
const GLYPHS = {
  space: " ", period: ".", comma: ",", colon: ":", semicolon: ";", hyphen: "-", endash: "\u2013",
  emdash: "\u2014", quoteright: "\u2019", quoteleft: "\u2018", quotedblleft: "\u201C", quotedblright: "\u201D",
  quotesingle: "'", quotedbl: '"', exclam: "!", question: "?", parenleft: "(", parenright: ")",
  slash: "/", ampersand: "&", percent: "%", dollar: "$", fi: "fi", fl: "fl", ff: "ff", ffi: "ffi",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

const glyphText = (name) => {
  if (name.length === 1) return name;
  if (GLYPHS[name]) return GLYPHS[name];
  const uni = /^uni([0-9A-Fa-f]{4})/.exec(name);
  return uni ? String.fromCharCode(parseInt(uni[1], 16)) : null;
};

/** How far each code in a shown string advances the pen, in ems. */
function advanceOf(objects, font) {
  const table = new Map();
  let fallback = 0.5;
  let bytes = 1;

  if (nameOf(font.Subtype) === "Type0") {
    bytes = 2;
    const descendant = resolve(objects, (resolve(objects, font.DescendantFonts) ?? [])[0]);
    fallback = (Number(resolve(objects, descendant?.DW)) || 1000) / 1000;
    const w = resolve(objects, descendant?.W);
    // [first [w w w] first last w ...]
    for (let i = 0; Array.isArray(w) && i < w.length; ) {
      const first = Number(resolve(objects, w[i]));
      const next = resolve(objects, w[i + 1]);
      if (Array.isArray(next)) {
        next.forEach((v, k) => table.set(first + k, (Number(resolve(objects, v)) || 0) / 1000));
        i += 2;
      } else {
        const width = (Number(resolve(objects, w[i + 2])) || 0) / 1000;
        for (let code = first; code <= Number(next) && code - first < 0x10000; code++) table.set(code, width);
        i += 3;
      }
    }
  } else {
    const first = Number(resolve(objects, font.FirstChar)) || 0;
    const widths = resolve(objects, font.Widths);
    if (Array.isArray(widths)) widths.forEach((v, k) => table.set(first + k, (Number(resolve(objects, v)) || 0) / 1000));
  }

  return (str) => {
    let sum = 0;
    for (let at = 0; at + bytes <= str.length; at += bytes) {
      const code = bytes === 2 ? (str.charCodeAt(at) & 0xff) * 256 + (str.charCodeAt(at + 1) & 0xff) : str.charCodeAt(at) & 0xff;
      sum += table.get(code) ?? fallback;
    }
    return sum;
  };
}

const PLAIN_FONT = { decode: fromWinAnsi, advance: (s) => s.length * 0.5 };

/** How to read one font: its strings as text, and how far each one moves the pen. */
async function fontReader(objects, fontValue) {
  const font = resolve(objects, fontValue);
  if (!font || typeof font !== "object") return PLAIN_FONT;
  const advance = advanceOf(objects, font);

  const toUnicode = font.ToUnicode;
  const entry = toUnicode && typeof toUnicode === "object" && "ref" in toUnicode ? objects.get(toUnicode.ref) : null;
  const data = entry ? await decodeStream(objects, entry) : null;
  if (data) {
    const cmap = parseCMap(binary(data));
    if (cmap.ranges.length) return { decode: (s) => decodeWithCMap(s, cmap), advance };
  }

  // A composite font with no map back to Unicode: its codes are glyph ids, and
  // there is no honest way to turn those into letters.
  if (nameOf(font.Subtype) === "Type0") return { decode: (s) => "\uFFFD".repeat(Math.ceil(s.length / 2)), advance };

  const encoding = resolve(objects, font.Encoding);
  const differences = new Map();
  if (encoding && typeof encoding === "object" && Array.isArray(encoding.Differences)) {
    let code = 0;
    for (const item of encoding.Differences) {
      if (typeof item === "number") code = item;
      else if (nameOf(item)) {
        const text = glyphText(nameOf(item));
        if (text !== null) differences.set(code, text);
        code++;
      }
    }
  }
  if (!differences.size) return { decode: fromWinAnsi, advance };
  return { decode: (s) => [...s].map((c) => differences.get(c.charCodeAt(0)) ?? fromWinAnsi(c)).join(""), advance };
}

// --- content streams -------------------------------------------------------------------

/**
 * What a content stream needs to be read: a decoder per font resource name, and
 * the already-decoded form XObjects it can draw. Resolved up front, so reading
 * the stream itself is synchronous.
 */
async function prepare(objects, resources, cache, depth = 0) {
  const res = resolve(objects, resources) ?? {};
  const fonts = {};
  const fontDict = resolve(objects, res.Font);
  if (fontDict && typeof fontDict === "object") {
    for (const [name, ref] of Object.entries(fontDict)) {
      const key = ref && typeof ref === "object" && "ref" in ref ? ref.ref : `${depth}:${name}`;
      if (!cache.has(key)) cache.set(key, await fontReader(objects, ref));
      fonts[name] = cache.get(key);
    }
  }

  const forms = {};
  const xobjects = resolve(objects, res.XObject);
  if (depth < 6 && xobjects && typeof xobjects === "object") {
    for (const [name, ref] of Object.entries(xobjects)) {
      const entry = ref && typeof ref === "object" && "ref" in ref ? objects.get(ref.ref) : null;
      if (!entry || nameOf(entry.value?.Subtype) !== "Form") continue;
      const data = await decodeStream(objects, entry);
      if (!data) continue;
      forms[name] = {
        content: binary(data),
        context: await prepare(objects, entry.value.Resources ?? resources, cache, depth + 1),
      };
    }
  }
  return { fonts, forms };
}

/**
 * The text drawn by one content stream.
 *
 * PDF has no lines, only positions, so a new line is inferred from the text
 * position moving vertically (Tm, Td, TD) or from the explicit next-line
 * operators (T*, ' and "). Chrome writes every visual line as its own text
 * object at a new y, and places punctuation with same-line Td moves — neither
 * of which should split a sentence.
 *
 * @param {string} content  the decoded stream, one char per byte
 * @param {{fonts?: Object<string, (s: string) => string>, forms?: object}} [context]
 */
export function pdfTextFromStream(content, context = {}) {
  const out = [];
  const state = { x: 0, y: 0, lineX: 0, lineY: 0, size: 1, leading: 0, endX: null, shownY: null, newline: false, font: PLAIN_FONT };
  runContent(content, context, state, out, 0);
  return tidy(out.join(""));
}

function runContent(content, { fonts = {}, forms = {} }, state, out, depth) {
  const lex = new Lexer(content);
  let stack = [];

  const moveTo = (x, y) => {
    state.lineX = state.x = x;
    state.lineY = state.y = y;
  };

  /** @param {number} advance  how far the text moved the pen, in ems */
  const emit = (text, advance) => {
    if (text) {
      const last = out.at(-1) ?? "";
      const moved = state.shownY !== null && Math.abs(state.y - state.shownY) > 0.5;
      if ((state.newline || moved) && out.length) {
        if (!last.endsWith("\n")) out.push("\n");
      } else if (state.endX !== null && state.x - state.endX > 0.25 * Math.abs(state.size) && !/\s$/.test(last) && !/^\s/.test(text)) {
        // A run placed well past where the last one ended, on the same line: a
        // table cell, a tab stop, a bullet. The gap is the space.
        out.push(" ");
      }
      state.newline = false;
      state.shownY = state.y;
      out.push(text);
    }
    state.x += advance * state.size;
    state.endX = state.x;
  };
  const show = (value) => {
    if (typeof value?.str === "string") emit(state.font.decode(value.str), state.font.advance(value.str));
  };

  for (let token = lex.next(); token; token = lex.next()) {
    if (token.t !== "op") {
      stack.push(parseValue(lex, token));
      continue;
    }
    const num = (i) => (typeof stack.at(i) === "number" ? stack.at(i) : 0);

    switch (token.v) {
      case "BI": {
        // An inline image: binary until a whitespace-delimited EI.
        const data = content.indexOf("ID", lex.at);
        const end = data === -1 ? -1 : content.slice(data + 2).search(/\sEI(?=\s|$)/);
        lex.at = end === -1 ? content.length : data + 2 + end + 3;
        break;
      }
      case "Tf":
        state.font = fonts[nameOf(stack.at(-2))] ?? PLAIN_FONT;
        state.size = num(-1) || 1;
        break;
      case "Tm":
        moveTo(num(-2), num(-1));
        break;
      case "Td":
        moveTo(state.lineX + num(-2), state.lineY + num(-1));
        break;
      case "TD":
        state.leading = -num(-1);
        moveTo(state.lineX + num(-2), state.lineY + num(-1));
        break;
      case "TL":
        state.leading = num(-1);
        break;
      case "T*":
        moveTo(state.lineX, state.lineY - state.leading);
        state.newline = true;
        break;
      case "BT":
        moveTo(0, 0);
        break;
      case "Tj":
        show(stack.at(-1));
        break;
      case "'":
      case '"':
        moveTo(state.lineX, state.lineY - state.leading);
        state.newline = true;
        show(stack.at(-1));
        break;
      case "TJ": {
        const parts = stack.at(-1);
        if (!Array.isArray(parts)) break;
        // Each string decodes on its own — a two-byte code never spans two of
        // them — and a large negative kern is how many generators write a gap.
        let text = "";
        let advance = 0;
        for (const part of parts) {
          if (typeof part === "number") {
            advance -= part / 1000;
            if (part < -200) text += " ";
          } else if (typeof part?.str === "string") {
            text += state.font.decode(part.str);
            advance += state.font.advance(part.str);
          }
        }
        emit(text, advance);
        break;
      }
      case "Do": {
        const form = forms[nameOf(stack.at(-1))];
        if (form && depth < 6) runContent(form.content, form.context, state, out, depth + 1);
        break;
      }
    }
    stack = [];
  }
}

function tidy(text) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- the whole file ---------------------------------------------------------------------

/** Streams that are never page text: font programs, images, metadata, indexes. */
function isNeverText(dict) {
  if (!dict || typeof dict !== "object") return true;
  if ("Length1" in dict || "Length2" in dict || "Length3" in dict) return true;
  const subtype = nameOf(dict.Subtype);
  if (["Image", "Type1C", "CIDFontType0C", "OpenType", "XML"].includes(subtype)) return true;
  return ["XRef", "ObjStm", "Metadata", "EmbeddedFile"].includes(nameOf(dict.Type));
}

/**
 * Every word in a PDF, page by page.
 *
 * Walks the page tree when the file has one, which is the only way to know
 * which font — and so which CMap — a string was drawn in. A file too broken
 * for that falls back to reading every content-like stream in file order.
 */
export async function pdfText(bytes) {
  const src = binary(bytes);
  const objects = readObjects(bytes, src);
  await expandObjectStreams(objects);

  const cache = new Map();
  const out = [];
  for (const { page, resources } of findPages(objects)) {
    const contents = resolve(objects, page.Contents);
    const refs = Array.isArray(contents) ? contents : page.Contents ? [page.Contents] : [];
    const parts = [];
    for (const ref of refs) {
      const entry = ref && typeof ref === "object" && "ref" in ref ? objects.get(ref.ref) : null;
      const data = await decodeStream(objects, entry);
      if (data) parts.push(binary(data));
    }
    if (!parts.length) continue;
    const text = pdfTextFromStream(parts.join("\n"), await prepare(objects, resources, cache));
    if (text) out.push(text);
  }
  if (out.length) return tidy(out.join("\n\n"));

  // No usable page tree: read whatever streams could be page text.
  for (const entry of objects.values()) {
    if (!entry.raw || isNeverText(entry.value)) continue;
    const data = await decodeStream(objects, entry);
    if (!data) continue;
    const content = binary(data);
    if (!/(?<![A-Za-z])BT(?![A-Za-z])/.test(content) || content.includes("begincmap")) continue;
    const text = pdfTextFromStream(content);
    if (text) out.push(text);
  }
  return tidy(out.join("\n"));
}

/**
 * Whether extracted text is noise rather than words.
 *
 * Two tells, both cheap: characters that are not letters, digits, punctuation
 * or symbols (control bytes and replacement characters — what glyph ids and
 * font programs decode to), and a run of Latin-1 accented letters far beyond
 * what any real language uses, which is what binary looks like through a
 * single-byte code page.
 */
export function looksGarbled(text) {
  const sample = String(text ?? "").slice(0, 20_000);
  let total = 0;
  let bad = 0;
  let high = 0;
  for (const ch of sample) {
    if (/\s/.test(ch)) continue;
    total++;
    if (ch === "\uFFFD" || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(ch)) bad++;
    else if (ch >= "\u0080" && ch <= "\u00ff") high++;
  }
  if (total < 1) return false;
  return bad / total > 0.1 || high / total > 0.25;
}
