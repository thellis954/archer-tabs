// Paints the suggestion rows.
//
// **Every string here comes from a page title or a prompt, and page titles are
// attacker-influenceable** — anyone who can get you to open a link controls one.
// So every insertion is `textContent`, and the markup itself comes from a
// <template> in newtab.html rather than from a string in this file. There is no
// code path in this module that can produce an element from text.
// `tools/lint.js` fails the build on innerHTML anywhere in extension/.

import { CONVERSATION } from "./conversations.js";

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
    node.classList.toggle("isConversation", row.kind === CONVERSATION);
    node.classList.toggle("isPrompt", row.kind !== CONVERSATION);
    node.classList.toggle("isPinned", Boolean(row.pinned));

    const title = node.querySelector(".title");
    const description = node.querySelector(".description");

    if (row.kind === CONVERSATION) {
      title.textContent = row.title;
      // An em dash only reads as a separator when there is something after it.
      description.textContent = row.prompt ? `— ${row.prompt}` : "";
      node.setAttribute("aria-label", row.prompt ? `${row.title} — ${row.prompt}` : row.title);
    } else {
      title.textContent = row.text;
      description.textContent = "— ask again";
      node.setAttribute("aria-label", `Ask again: ${row.text}`);
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

const plain = (row) => (row.kind === CONVERSATION ? row.title : row.text);

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
