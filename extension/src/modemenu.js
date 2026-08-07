// The `Auto ⌄` control in the top bar, as a real listbox.
//
// Small enough not to want a framework, fussy enough to be worth isolating:
// roving tabindex, the arrow-key model, click-outside, and returning focus to
// the button on close are all things that are easy to half-do.

const OPEN = "open";

/**
 * @param {object} parts
 * @param {HTMLButtonElement} parts.button
 * @param {HTMLElement} parts.menu      a [role=listbox] whose children are [role=option][data-mode]
 * @param {HTMLElement} parts.label     the text node inside the button
 * @param {(mode: string) => void} parts.onSelect
 */
export function createModeMenu({ button, menu, label, onSelect }) {
  const options = () => [...menu.querySelectorAll("[role=option]")];

  let current = null;

  function isOpen() {
    return button.getAttribute("aria-expanded") === "true";
  }

  function open() {
    button.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    menu.classList.add(OPEN);
    (options().find((o) => o.dataset.mode === current) ?? options()[0])?.focus();
  }

  function close({ refocus = true } = {}) {
    if (!isOpen()) return;
    button.setAttribute("aria-expanded", "false");
    menu.hidden = true;
    menu.classList.remove(OPEN);
    if (refocus) button.focus();
  }

  function select(mode) {
    setMode(mode);
    onSelect?.(mode);
    close();
  }

  /** Reflects a mode into the UI without reporting it back — used on load. */
  function setMode(mode) {
    current = mode;
    for (const option of options()) {
      const chosen = option.dataset.mode === mode;
      option.setAttribute("aria-selected", String(chosen));
      // Roving tabindex: exactly one option is in the tab order at a time.
      option.tabIndex = chosen ? 0 : -1;
      if (chosen) label.textContent = option.dataset.label ?? option.textContent.trim();
    }
    button.setAttribute("aria-label", `Routing mode: ${label.textContent}`);
  }

  function move(from, delta) {
    const all = options();
    const at = all.indexOf(from);
    all[(at + delta + all.length) % all.length]?.focus();
  }

  button.addEventListener("click", () => (isOpen() ? close() : open()));

  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[role=option]");
    if (option) select(option.dataset.mode);
  });

  menu.addEventListener("keydown", (event) => {
    const option = event.target.closest("[role=option]");
    if (!option) return;

    switch (event.key) {
      case "ArrowDown": move(option, 1); break;
      case "ArrowUp": move(option, -1); break;
      case "Home": options()[0]?.focus(); break;
      case "End": options().at(-1)?.focus(); break;
      case "Enter":
      case " ": select(option.dataset.mode); break;
      case "Escape": close(); break;
      case "Tab": close({ refocus: false }); return; // let Tab do its job
      default: return;
    }
    event.preventDefault();
  });

  // Pointer-down rather than click: a click that starts inside and ends outside
  // would otherwise leave the menu open.
  document.addEventListener("pointerdown", (event) => {
    if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) {
      close({ refocus: false });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      close();
      event.stopPropagation(); // don't also clear the search box
    }
  }, true);

  return { setMode, close, isOpen };
}
