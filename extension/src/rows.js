// Paints the suggestion rows.
//
// **Every string here comes from a page title or a prompt, and page titles are
// attacker-influenceable** — anyone who can get you to open a link controls one.
// So every insertion is `textContent`, and the markup itself comes from a
// <template> in newtab.html rather than from a string in this file. There is no
// code path in this module that can produce an element from text.
// `tools/lint.js` fails the build on innerHTML anywhere in extension/.

import { CONVERSATION, PROMPT_ROW, SITE, CLOSED } from "./conversations.js";


/** What each row kind says after its title, when it has nothing of its own. */
const SUFFIX = {
  [PROMPT_ROW]: "— ask again",
  [SITE]: "— you visit this a lot",
  [CLOSED]: "— recently closed",
};

const template = () => document.getElementById("rowTemplate");

/**
 * @param {HTMLElement} list  the [role=listbox]
 * @param {Array<object>} rows
 * @param {{onOpen: Function, onPin: Function, onDismiss: Function}} handlers
 */
export function renderRows(list, rows, { onOpen, onPin, onDismiss }) {
  list.replaceChildren();

  rows.forEach((row, index) => {
    const node = template().content.firstElementChild.cloneNode(true);

    node.id = `row-${index}`;
    node.dataset.rowId = row.id;
    node.dataset.index = String(index);
    node.dataset.kind = row.kind;
    // Derived from the kind rather than enumerated, so a new row kind cannot be
    // added without its class arriving with it.
    node.classList.add(`is-${row.kind}`);
    node.classList.toggle("isPinned", Boolean(row.pinned));

    const title = node.querySelector(".title");
    const description = node.querySelector(".description");

    if (row.kind === CONVERSATION) {
      title.textContent = row.title;
      // With more than one assistant in the list, a row has to say which one it
      // came from — otherwise two identical-looking rows go to different places.
      // A conversation Chrome never titled takes its prompt as the title, so
      // repeating it here would print the same sentence twice on one row.
      const extra = row.prompt && row.prompt !== row.title ? row.prompt : "";
      const detail = extra ? `${row.provider ?? ""} · ${extra}`.replace(/^ · /, "") : row.provider ?? "";
      description.textContent = detail ? `— ${detail}` : "";
      node.setAttribute("aria-label", detail ? `${row.title} — ${detail}` : row.title);
    } else if (row.kind === PROMPT_ROW) {
      title.textContent = row.text;
      description.textContent = SUFFIX[PROMPT_ROW];
      node.setAttribute("aria-label", `Ask again: ${row.text}`);
    } else {
      title.textContent = row.title;
      description.textContent = SUFFIX[row.kind] ?? "";
      node.setAttribute("aria-label", `${row.title} ${SUFFIX[row.kind] ?? ""}`.trim());
    }

    const pin = node.querySelector(".pin");
    pin.setAttribute("aria-label", row.pinned ? `Unpin ${plain(row)}` : `Pin ${plain(row)}`);
    pin.addEventListener("click", (event) => {
      event.stopPropagation(); // the row underneath must not also open
      onPin(row);
    });

    const dismiss = node.querySelector(".dismissRow");
    dismiss.setAttribute("aria-label", `Dismiss ${plain(row)}`);
    dismiss.addEventListener("click", (event) => {
      event.stopPropagation();
      onDismiss(row);
    });

    node.addEventListener("click", (event) => {
      if (event.target.closest(".rowBtn")) return;
      onOpen(row);
    });

    list.append(node);
  });
}

const plain = (row) => row.title || row.text || "";

/** Moves the visual and assistive-tech selection to `index`, or clears it at -1. */
export function setActiveRow(list, input, index) {
  const options = [...list.children];

  options.forEach((option, at) => {
    const active = at === index;
    option.classList.toggle("isActive", active);
    option.setAttribute("aria-selected", String(active));
  });

  const active = options[index];
  if (active) {
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
}
