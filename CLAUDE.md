# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome Manifest V3 extension that replaces the browser's New Tab page with an Atlas/ChatGPT-styled
search page. Four files, no dependencies, no build step, no test suite — the source *is* the shipped
artifact, and the browser loads these files verbatim.

## Development loop

There is nothing to build or install. To run it:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the repo root.
2. Open a new tab to see the page.
3. After editing `newtab.html`/`newtab.css`/`newtab.js`, just open a new tab — the page reloads from
   disk. Only `manifest.json` changes require hitting **Reload** on the extension card.

Verification is manual: exercise the omnibox by hand (a bare domain, a full URL, `localhost:3000`, a
plain search phrase) and check the resulting navigation. There is no linter or CI.

## Architecture

`manifest.json` declares exactly one entry point — `chrome_url_overrides.newtab` → `newtab.html`.
Everything else is reached from that page. Adding a new page or a background service worker means
registering it in the manifest; a file that isn't referenced from `newtab.html` or the manifest is
dead weight.

**`newtab.js` is the only logic in the extension.** It owns a single decision: on form submit, does
the input look like a URL or a search query? `looksLikeURL()` is the heuristic — explicit
`http(s)://` scheme, a `localhost[:port]` prefix, or any whitespace-free string containing a dot.
Anything else falls through to a Google search URL. Navigation is done by assigning
`window.location.href`, so the new tab page replaces itself rather than opening a tab.

Two things in the UI are **currently decorative** — know this before "fixing" what looks broken:

- The `.plus` and `.mic` buttons are `type="button"` with no listeners.
- The three `.suggestion` buttons (ChatGPT / GitHub / Notion) are static markup; nothing wires them
  to their destinations.

Wiring them up is real work, not a bug fix.

## Constraints worth knowing

- **MV3 content security policy forbids inline script and inline event handlers on extension pages.**
  Keep JS in `newtab.js` (or another external file) and attach listeners with `addEventListener` —
  an `onclick=` attribute will silently fail to fire.
- **No remote code and no network fetches are set up.** There are no `host_permissions` and no
  `permissions` in the manifest. Anything beyond same-page navigation (search suggestions, favicons,
  history/topSites access) requires adding the relevant permission and will change the extension's
  install-time consent prompt.
- The layout uses fixed pixel widths (`795px` search box, `760px` suggestion list) and a fixed
  `155px` top offset. It is deliberately not responsive; changing one width means changing the other
  to keep them aligned.
- Bump `version` in `manifest.json` for any change intended to ship — Chrome refuses to update an
  unpacked or packed extension without a version increase.

## License

GPL-3.0. New source files should be compatible with that.
