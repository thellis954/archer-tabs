// Renders a model's Markdown answer as real paragraphs, lists, code and links.
//
// An answer is text from a remote model, steerable by whatever the prompt
// quoted — a pasted page, an attached file — so it is untrusted. This module
// therefore has no path from text to markup: `parse` turns text into plain
// objects, and `render` builds elements with createElement and textContent.
// Links are kept only when they are http(s); anything else stays text.
//
// Deliberately small. It covers what chat models actually write — headings,
// lists, fenced code, quotes, tables, emphasis, inline code, links — and
// renders anything it does not recognise as the text it is. It is re-run on
// the whole answer as it streams, so an unclosed fence or ** is normal input.

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** @typedef {{type: string, [key: string]: any}} Block */

/** Markdown text → a list of blocks. Pure and total. */
export function parse(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  /** @type {Block[]} */
  const blocks = [];
  let paragraph = null;
  let list = null;

  const close = () => {
    paragraph = null;
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      close();
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim().startsWith(fence[1][0].repeat(fence[1].length)) && FENCE.test(lines[j])) break;
        body.push(lines[j]);
      }
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      i = j;
      continue;
    }

    if (!line.trim()) {
      // A blank line ends a paragraph; a list survives one, as "loose" lists do.
      paragraph = null;
      if (list && !(BULLET.test(lines[i + 1] ?? "") || NUMBERED.test(lines[i + 1] ?? ""))) list = null;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      close();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }

    if (RULE.test(line)) {
      close();
      blocks.push({ type: "rule" });
      continue;
    }

    if (line.includes("|") && TABLE_RULE.test(lines[i + 1] ?? "") && lines[i + 1].includes("-")) {
      close();
      const header = cells(line);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) rows.push(cells(lines[j]));
      blocks.push({ type: "table", header, rows });
      i = j - 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      paragraph = null;
      list = null;
      const last = blocks.at(-1);
      if (last?.type === "quote") last.lines.push(quote[1]);
      else blocks.push({ type: "quote", lines: [quote[1]] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      paragraph = null;
      const ordered = Boolean(numbered);
      const item = (bullet ? bullet[2] : numbered[3]) ?? "";
      if (!list || list.ordered !== ordered) {
        list = { type: "list", ordered, start: ordered ? Number(numbered[2]) : 1, items: [] };
        blocks.push(list);
      }
      list.items.push(item);
      continue;
    }

    // An indented line under a list item continues that item.
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += "\n" + line.trim();
      continue;
    }

    list = null;
    if (paragraph) paragraph.lines.push(line.trim());
    else {
      paragraph = { type: "paragraph", lines: [line.trim()] };
      blocks.push(paragraph);
    }
  }
  return blocks;
}

function cells(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** @typedef {{type: "text"|"code"|"strong"|"em"|"link"|"break", text?: string, href?: string, children?: Inline[]}} Inline */

/** One line of inline Markdown → spans. Pure and total. */
export function parseInline(text) {
  /** @type {Inline[]} */
  const out = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
  };
  const src = String(text ?? "");

  for (let i = 0; i < src.length; ) {
    const ch = src[i];

    if (ch === "\\" && /[\\`*_[\]()#+\-.!|>~]/.test(src[i + 1] ?? "")) {
      plain += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") {
      flush();
      out.push({ type: "break" });
      i++;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(src.slice(i))[0];
      const end = src.indexOf(run, i + run.length);
      if (end !== -1) {
        flush();
        out.push({ type: "code", text: src.slice(i + run.length, end).replace(/^ (.+) $/, "$1") });
        i = end + run.length;
        continue;
      }
    }

    if (ch === "[") {
      const link = /^\[([^\]\n]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i));
      if (link) {
        flush();
        if (/^https?:\/\//i.test(link[2])) out.push({ type: "link", href: link[2], children: parseInline(link[1]) });
        else out.push(...parseInline(link[1]));
        i += link[0].length;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const double = src[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      const before = src[i - 1] ?? " ";
      const after = src[i + marker.length] ?? " ";
      // Underscores inside words (snake_case) are not emphasis; nor is a
      // marker followed by a space ("2 * 3").
      const opens = !/\s/.test(after) && (ch === "*" || !/[\p{L}\p{N}]/u.test(before));
      if (opens) {
        const end = findCloser(src, i + marker.length, marker);
        if (end !== -1) {
          flush();
          out.push({ type: double ? "strong" : "em", children: parseInline(src.slice(i + marker.length, end)) });
          i = end + marker.length;
          continue;
        }
      }
    }

    if (ch === "h" && /^https?:\/\//i.test(src.slice(i, i + 8)) && !/[\p{L}\p{N}]/u.test(src[i - 1] ?? " ")) {
      const url = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/i.exec(src.slice(i));
      if (url) {
        flush();
        out.push({ type: "link", href: url[0], children: [{ type: "text", text: url[0] }] });
        i += url[0].length;
        continue;
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return out;
}

function findCloser(src, from, marker) {
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "`") {
      const close = src.indexOf("`", j + 1);
      if (close !== -1) j = close;
      continue;
    }
    if (src.startsWith(marker, j) && !/\s/.test(src[j - 1]) && j > from) {
      if (marker.length === 1 && src[j + 1] === marker) {
        j++;
        continue;
      }
      const next = src[j + marker.length] ?? " ";
      if (marker[0] === "_" && /[\p{L}\p{N}]/u.test(next)) continue;
      return j;
    }
  }
  return -1;
}

/** The answer's plain text, for copying and for the conversation hand-off. */
export function plainText(blocks) {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "code":
          return block.text;
        case "list":
          return block.items.join("\n");
        case "quote":
        case "paragraph":
          return block.lines.join("\n");
        case "table":
          return [block.header, ...block.rows].map((row) => row.join("\t")).join("\n");
        case "rule":
          return "";
        default:
          return block.text ?? "";
      }
    })
    .join("\n\n");
}

// --- the DOM half ------------------------------------------------------------------

/**
 * Replaces `container`'s children with the rendered answer.
 * @param {HTMLElement} container
 * @param {string} text
 */
export function render(container, text) {
  const doc = container.ownerDocument;
  const el = (tag, className) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  const inline = (parent, spans) => {
    for (const span of spans) {
      switch (span.type) {
        case "text":
          parent.append(doc.createTextNode(span.text));
          break;
        case "break":
          parent.append(el("br"));
          break;
        case "code": {
          const code = el("code");
          code.textContent = span.text;
          parent.append(code);
          break;
        }
        case "strong":
        case "em": {
          const node = el(span.type);
          inline(node, span.children);
          parent.append(node);
          break;
        }
        case "link": {
          const a = el("a");
          a.href = span.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          inline(a, span.children);
          parent.append(a);
          break;
        }
      }
    }
  };

  const nodes = parse(text).map((block) => {
    switch (block.type) {
      case "heading": {
        // h1 inside an answer panel would outrank the page; start at h3.
        const node = el(`h${Math.min(6, block.level + 2)}`);
        inline(node, parseInline(block.text));
        return node;
      }
      case "code": {
        const pre = el("pre");
        const code = el("code");
        code.textContent = block.text;
        if (block.lang) code.dataset.lang = block.lang;
        pre.append(code);
        return pre;
      }
      case "list": {
        const list = el(block.ordered ? "ol" : "ul");
        if (block.ordered && block.start !== 1) list.start = block.start;
        for (const item of block.items) {
          const li = el("li");
          inline(li, parseInline(item));
          list.append(li);
        }
        return list;
      }
      case "quote": {
        const quote = el("blockquote");
        const p = el("p");
        inline(p, parseInline(block.lines.join("\n")));
        quote.append(p);
        return quote;
      }
      case "table": {
        const wrap = el("div", "tableWrap");
        const table = el("table");
        const head = el("thead");
        const tr = el("tr");
        for (const cell of block.header) {
          const th = el("th");
          inline(th, parseInline(cell));
          tr.append(th);
        }
        head.append(tr);
        const body = el("tbody");
        for (const row of block.rows) {
          const r = el("tr");
          for (const cell of row) {
            const td = el("td");
            inline(td, parseInline(cell));
            r.append(td);
          }
          body.append(r);
        }
        table.append(head, body);
        wrap.append(table);
        return wrap;
      }
      case "rule":
        return el("hr");
      default: {
        const p = el("p");
        inline(p, parseInline(block.lines.join("\n")));
        return p;
      }
    }
  });
  container.replaceChildren(...nodes);
}
