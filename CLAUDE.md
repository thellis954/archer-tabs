# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Atlas New Tab is a Chrome Manifest V3 extension that overrides the browser's New Tab page (`chrome_url_overrides.newtab`) with a custom Atlas-style search page. It is plain static HTML/CSS/JS — no build step, no bundler, no package manager, no tests, no dependencies.

## Running / testing

There is no build or test command. To load and test:

1. Open `chrome://extensions`, enable Developer mode.
2. "Load unpacked" → select this repo's root directory.
3. Open a new tab to see `newtab.html`. After editing files, click the reload icon on the extension card (or reopen the new tab) to pick up changes.

Because it's static, you can also open `newtab.html` directly in a browser for quick markup/style iteration — but the extension context (new-tab override) only exists when loaded as an unpacked extension.

## Architecture

Three files render the page; `manifest.json` wires it up:

- `manifest.json` — MV3 manifest; the only key that matters is `chrome_url_overrides.newtab → newtab.html`. Bump `version` here when publishing.
- `newtab.html` — the page: a logo, a search form (`#searchForm` wrapping `#query`), and a static list of `.suggestion` buttons. Loads `newtab.css` then `newtab.js`.
- `newtab.css` — all styling. Fixed pixel widths (search box `795px`, suggestions `760px`) — this is a centered fixed-width layout, not responsive.
- `newtab.js` — the only behavior. On form submit it reads `#query`, and via `looksLikeURL()` decides between navigating to a URL (prepending `https://` if no scheme) vs. redirecting to a Google search. The `.plus`, `.mic`, and `.suggestion` buttons are currently decorative (`type="button"`, no handlers).

Key detail: element IDs (`searchForm`, `query`) are the contract between `newtab.html` and `newtab.js` — keep them in sync when editing either file.
