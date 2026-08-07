# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Archer** — a Chrome Manifest V3 extension that replaces the browser's New Tab page with a calm
ask-or-navigate search page, in the spirit of the (now retired) ChatGPT Atlas new tab. No
dependencies, no build step, no test suite — the source *is* the shipped artifact, and the browser
loads these files verbatim.

Don't reintroduce OpenAI's marks, wordmark, or the old name into shipped UI — see `docs/BRAND.md`.

## Layout

```
extension/   everything Chrome loads — this is what you point "Load unpacked" at
  src/       classify.js (the URL-vs-prompt decision) + the generated TLD list
web/         the archertabs.app marketing site, deployed to Vercel from this folder
docs/        ROADMAP.md (the plan + its constraints), BRAND.md (mark, palette, voice)
tools/       lint.js + png.js (dependency-free); genicons.mjs, shots.mjs (need playwright)
test/        *.test.js run by `npm test`; e2e.mjs drives a real browser
```

Nothing outside `extension/` ships to users. `vercel.json` at the root sets
`outputDirectory: "web"`, so the site deploys from a repo whose main product is the extension.

**Read `docs/ROADMAP.md` before making substantive changes.** It carries the audit of the current
build (including known bugs in the URL/prompt classifier), the constraints that bound the design —
Chrome Web Store search policy, OpenAI trademark, and the fact that no sanctioned API exposes ChatGPT
conversation history — and the phased plan. The scope decision that matters most: **this extension
owns the new tab page only.** Making ChatGPT the address-bar default search engine is handled by
OpenAI's own "ChatGPT search" extension, not by this one.

## Development loop

There is nothing to build or install. To run it:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the **`extension`
   folder** (not the repo root — the root holds the site and tooling too).
2. Open a new tab to see the page.
3. After editing `newtab.html`/`newtab.css`/`newtab.js`, just open a new tab — the page reloads from
   disk. Only `manifest.json` changes require hitting **Reload** on the extension card.

| Command | What it does |
|---|---|
| `npm test` | 47 unit cases for the classifier, on node's built-in runner. No install needed. |
| `npm run lint` | This repo's own invariants (see `tools/lint.js`) — not a style linter. |
| `npm run e2e` | Drives a real Chromium with the extension loaded. Needs Playwright. |
| `npm run shots` | Renders the page to `shots/` — light, dark, narrow, and a filled/hovered state. |
| `npm run icons` | Regenerates `extension/assets/icon-*.png` from the mark. |
| `npm run check` | lint + test — what CI runs. |

`e2e`, `shots` and `icons` all need Playwright on the module path:

```sh
mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
```

CI runs lint and unit tests only: the repo installs nothing, and `e2e` needs a browser.
**`npm run e2e` is the check that matters before shipping a routing change** — it exercises
`chrome.search` and real navigation, which unit tests cannot. **And look at `npm run shots` before
shipping a UI change** — the suggestion-row misalignment and the sub-AA `--muted` were both
invisible in the source and obvious in a render.

## Architecture

`manifest.json` declares exactly one entry point — `chrome_url_overrides.newtab` → `newtab.html`.
Everything else is reached from that page. Adding a new page or a background service worker means
registering it in the manifest; a file that isn't referenced from `newtab.html` or the manifest is
dead weight.

**`newtab.js` is the only logic in the extension.** It owns a single decision: on submit, is the
input a URL or a prompt? That decision lives in `src/classify.js` — a pure, total function with 47
unit cases behind it. A URL verdict is navigated with `window.location.assign`; a prompt verdict
goes to `chrome.search.query()`, which routes to the user's own default engine. **Only `http(s)` is
ever navigable** — `javascript:`, `data:` and `file:` are classified as prompts, because this page
runs in a privileged extension origin.

Some of the UI is **still decorative** — know this before "fixing" what looks broken:

- The `.plus`, `.mode` and sidebar buttons are `type="button"` with no listeners. Roadmap Phase 2
  wires `.mode`, Phase 5 wires `.plus`.
- The three `.suggestion` rows are placeholder copy. Roadmap Phase 3 replaces them with real recent
  conversations; when it does, render that text with `textContent`, never `innerHTML` — page titles
  are attacker-influenceable.

Wiring them up is real work, not a bug fix. The send button (`#send`) is *not* decorative: it
submits, and it stays `disabled` until the input has content.

`newtab.css` is a token system: every color is a custom property on `:root`, redefined once under
`prefers-color-scheme: dark`. Add colors as tokens, never as literals in a rule — a hard-coded hex
is invisible in one of the two themes. `docs/BRAND.md` explains what each token is for and why brass
is restricted to the mark, focus, and hover.

## Constraints worth knowing

- **MV3 content security policy forbids inline script and inline event handlers on extension pages.**
  Keep JS in `newtab.js` (or another external file) and attach listeners with `addEventListener` —
  an `onclick=` attribute will silently fail to fire.
- **No remote code and no network fetches are set up.** There are no `host_permissions` and no
  `permissions` in the manifest. Anything beyond same-page navigation (search suggestions, favicons,
  history/topSites access) requires adding the relevant permission and will change the extension's
  install-time consent prompt.
- The search box and suggestion list are capped at `795px` / `760px` but fluid below that. Keep the
  pair proportional — the rows are meant to sit visually inside the box's width.
- **`assets/icon-*.png` are generated, not hand-drawn.** Edit the mark geometry in `docs/BRAND.md` +
  `tools/genicons.mjs`, then re-run `npm run icons`. Editing the PNGs directly gets overwritten.
  Generation is on Playwright rather than `chrome --screenshot` for a reason: headless Chromium
  clips its paint to *(window height − 88px)* but writes a screenshot the full window height, which
  silently shipped ~60% transparent icons. `npm run lint` reads the pixels back so it can't recur.
- Bump `version` in `manifest.json` for any change intended to ship — Chrome refuses to update an
  unpacked or packed extension without a version increase.

## License

GPL-3.0. New source files should be compatible with that.
