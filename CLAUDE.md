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
  src/       classify.js, router.js, conversations.js, history.js, rows.js, answer.js,
             clock.js, weather.js, favourites.js, dashboard.js, library.js, analytics.js,
             browsing.js, settings.js, modemenu.js, extract.js + the generated TLD list
  options.*  the settings page — API key, model, budget
web/         the archertabs.app marketing site, deployed to Vercel from this folder
  app.js     wires the two live demos; imports from vendor/
  vendor/    classify.js, router.js, tlds.js — byte-identical copies of
             extension/src/, pinned by tools/lint.js. See "The site" below
  assets/    the Blender renders, the fonts, the generated screenshots + OG card
docs/        ROADMAP.md (the plan + its constraints), BRAND.md (mark, palette, voice)
tools/       lint.js + png.js (dependency-free); genicons.mjs, shots.mjs,
             siteshots.mjs, ogcard.mjs, towebp.mjs (need playwright);
             render-arc.py (needs Blender)
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
| `npm test` | 237 unit cases across the pure modules. No install needed. |
| `npm run lint` | This repo's own invariants (see `tools/lint.js`) — not a style linter. |
| `npm run e2e` | Drives a real Chromium with the extension loaded. Needs Playwright. |
| `npm run shots` | Renders the page to `shots/` — light, dark, narrow, and a filled/hovered state. **Also rewrites `web/assets/newtab-{light,dark}.png`**, the screenshot the site ships. |
| `npm run siteshots` | Renders the marketing site to `shots/site/` — both themes, three widths, and the demo/scrollytell/lab mid-interaction. |
| `npm run og` | Regenerates `web/assets/og.png`, the social card. |
| `npm run icons` | Regenerates `extension/assets/icon-*.png` from the mark. |
| `npm run store` | Regenerates the Web Store screenshots and promo tiles into `store/`. |
| `npm run live` | A **headed** Chromium on a real X display, photographed whole — browser chrome included. |
| `npm run check` | lint + test — what CI runs. |

**`npm run live` is the one that can see what the others cannot.** Everything else here drives
*headless* Chromium, which never draws a toolbar, never resolves a native permission dialog, and
never renders `chrome://newtab` through the override. Three things this project got wrong were
invisible until someone looked at a real browser window:

- the icons shipped blank for the project's whole life — headless has no toolbar to show them in;
- `chrome.permissions.request()` hangs forever headless, which is why the granted-permission tests
  need a fixture that skips consent;
- the first tab of a session shows Chrome's own new tab, because the extension has not finished
  loading yet. Not a bug — but it looks exactly like one.

It needs `Xvfb`, `openbox`, `xwd`, ImageMagick and `xdotool` (`apt-get install x11-apps imagemagick
xdotool openbox`), and it starts the display and window manager itself if they are not up.

```sh
npm run live                                        # photograph the new tab
npm run live -- --url chrome://extensions --shot ext
npm run live -- --keep                              # leave it up, CDP on :9222
```

`e2e`, `shots`, `icons`, `store` and `live` all need Playwright on the module path:

```sh
mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright
```

CI runs lint and unit tests only: the repo installs nothing, and `e2e` needs a browser.
**`npm run e2e` is the check that matters before shipping a routing change** — it exercises
`chrome.search` and real navigation, which unit tests cannot. **And look at `npm run shots` before
shipping a UI change** — the suggestion-row misalignment and the sub-AA `--muted` were both
invisible in the source and obvious in a render.

## Architecture

`manifest.json` declares two pages — `chrome_url_overrides.newtab` → `newtab.html`, and
`options_page` → `options.html`. Everything else is reached from those. Adding a page or a
background service worker means registering it in the manifest, **and adding it to the page lists in
`tools/lint.js`** — the CSP, missing-file, `type="module"` and CSS-token rules are all driven off
those lists. A file that isn't referenced from a page or the manifest is dead weight.

**The decisions live in pure functions; `newtab.js` only wires the DOM.**

- `src/classify.js` — is this string a URL or a prompt? Total, no I/O, 47 unit cases.
- `src/router.js` — that verdict plus the routing mode plus any modifier key → one of
  `none` / `navigate` / `search` / `ask`. Also pure, 29 unit cases.
- `src/conversations.js` — `chrome.history` visits + the launch log → the suggestion rows.
  Collapsing, prompt binding, pinning and fuzzy filtering all happen here. Pure, 39 unit cases.
- `src/settings.js` — the only thing that touches `chrome.storage`.
- `src/history.js` — the only thing that touches `chrome.history` and `chrome.permissions`.
- `src/rows.js` — paints the rows.
- `src/answer.js` — the only caller of `api.openai.com`. The SSE framing and the budget maths are
  pure functions so they can be tested without a network.
- `src/clock.js`, `src/weather.js`, `src/favorites.js` — the dashboard's decisions. All pure;
  `src/dashboard.js` is the only part that touches the DOM or the network.
- `src/modemenu.js` — the mode listbox in the top bar, and the `+` menu.
- `src/extract.js` — an attached file → text a model can read. Unzips `.docx`/`.xlsx`/`.pptx` and
  inflates PDF streams using `DecompressionStream`, which node has too, so all of it is unit-tested.
  **It never pretends**: a file it cannot read still attaches, carrying a `note` saying why — a
  scanned PDF reads "no text layer", not silence.
- `src/permissions.js` — every optional permission, with the plain-language reason the settings
  page shows beside it. **Adding a capability that needs a permission means adding it here too** —
  an e2e case asserts this list accounts for every optional permission the manifest declares.

**Favourite icons come from Chrome's local store, never from the site.** `faviconURL()` builds a
`/_favicon/` URL, which reads the icon database the browser already built from your history — no
request leaves the device. Fetching `https://site/favicon.ico` per tile would need no permission and
is exactly what not to do: it announces every favourite to its operator on every new tab. And
`_favicon` **never fails** — an unknown site gets a generic globe, byte-identical every time — so the
fallback to initials cannot be an `onerror` handler. `dashboard.js` fetches the placeholder once, by
asking about an address that cannot resolve, and compares.

**Chrome's permission popup opens at the top of the window, with Deny focused.** That is far from
whatever button was pressed, and it is why "none of the toggles work" was reported about switches
that all worked. Anything that calls `chrome.permissions.request()` must say what happened when the
answer is no — a control that redraws unchanged is indistinguishable from a dead one. Never `await`
a permission request before doing the work the user asked for, either: the popup blocks until it is
answered.

**The destination pills and the top-bar menu are one setting.** Both write `mode`; both are kept in
sync by `syncTargets()`. The pills carry four of the seven modes — a mode with no pill presses none
of them rather than showing a wrong one, which is why the fresh-install default is `google` and not
`auto`: a page that opens with no pill pressed gives you nothing to read the next Enter off.

**A pill that names a place goes to that place.** `google`, `chatgpt`, `claude` and `perplexity` are
plain `?q=` navigations to a named destination. `auto` and `search` are the two that defer to
`chrome.search` — the user's *default engine*, which Archer never changes and cannot read. Keep that
line clean: the pill labelled "Search" used to be `data-mode="auto"`, so for anyone whose default was
ChatGPT it reached ChatGPT. Anything on the page that says "your default search engine" — the hint
under the box — must only appear in those two modes.

**Adding a mode means adding its `<option>` to `options.html`.** The settings dropdown renders blank
when the stored value matches no option; an e2e check asserts it covers every mode the menu offers.

**Only `http(s)` is ever navigable.** `javascript:`, `data:` and `file:` classify as prompts, because
this page runs in a privileged extension origin — a `javascript:` URL would execute *here*. A unit
test asserts no mode/modifier combination can produce a non-`http(s)` URL; keep it that way.

Navigation goes through `chrome.tabs.update`, which **does not need the `tabs` permission** — that
permission gates reading a tab's url/title. Don't add it "for correctness"; its install prompt reads
"Read your browsing history".

Some of the UI is **still decorative** — know this before "fixing" what looks broken:

- The `.plus` and sidebar buttons are `type="button"` with no listeners. Roadmap Phase 5 wires
  `.plus`. The `.mode` button is real as of Phase 2.
Wiring it up is real work, not a bug fix. The send button (`#send`), the mode picker and the
suggestion rows are all real.

**The suggestion rows are built from attacker-influenceable text.** A conversation title is whatever
a page's `<title>` said, and anyone who can get you to open a link controls one. So `src/rows.js`
clones a `<template>` from `newtab.html` and assigns `textContent` — it contains no code path that
can turn text into an element, which is a stronger guarantee than remembering to escape. Keep it that
way; `npm run lint` fails the build on `innerHTML` anywhere under `extension/`.

`newtab.css` is a token system: every color is a custom property on `:root`, redefined once under
`prefers-color-scheme: dark`. Add colors as tokens, never as literals in a rule — a hard-coded hex
is invisible in one of the two themes. `docs/BRAND.md` explains what each token is for and why brass
is restricted to the mark, focus, and hover.

## The site

`web/` is the landing page plus `/privacy`, built the same way the extension is: native CSS, ES
modules, no framework and no build step. `vercel.json` sets `outputDirectory: "web"`, so what is in
that folder is what is served, and `cleanUrls` is why `privacy.html` answers at `/privacy`.

**`vercel.json`'s CSP is load-bearing and `npm run lint` checks it.** It shipped `script-src 'none'`
at one point, which would have left the live demos dead on the deployed site while every local
render looked perfect. Nothing else in this repo could have caught that.

**`/privacy` is the Web Store's required hosted policy URL.** `docs/PRIVACY.md` is the canonical
text and `web/privacy.html` renders it; lint checks that the two agree on the date and that every
optional permission the manifest declares is explained on the page, so adding a capability without
saying why fails the build. Keep both in step.

**The two demos on the page run the extension's real classifier.** `web/vendor/` holds
byte-identical copies of `extension/src/{classify,router,tlds}.js`, and **`npm run lint` fails if
they drift** — Vercel only deploys `web/`, so the modules have to physically live there, which is
exactly the arrangement that rots silently. The site claims "the same code Chrome runs"; the lint
rule is what makes that claim true. After changing the classifier or the router:

```sh
cp extension/src/{classify,router,tlds}.js web/vendor/
```

The no-`innerHTML` rule extends to `web/app.js` for the same reason it exists in the extension: the
demo echoes whatever a reader types back into the page.

Design notes, so they are not re-litigated:

- **The palette is `docs/BRAND.md`, unchanged.** Warm cream and brass are the shipped product's
  tokens. The site adds exactly two of its own (`--raised`, `--scrim`) for section bands and
  shadows, and they are mixed from the existing tokens rather than picked.
- **Geist + Geist Mono**, self-hosted from `web/assets/fonts/` (SIL OFL, licence alongside them).
  The *extension* deliberately uses the system stack, because a new tab page must paint instantly;
  a marketing page has no such constraint. Mono carries every string the classifier judges.
- **`assets/arc-*.webp` are generated**, by `tools/render-arc.py` (Blender) then `tools/towebp.mjs`.
  They are an abstract study of the bowstring curve, not the mark in 3D — `docs/BRAND.md` forbids
  rotating, filling or gradient-ing the mark, and that applies to renders of it.
- **No scroll listeners.** The scrollytelling in "How it decides" is an IntersectionObserver; the
  section reveals are CSS `animation-timeline: view()` behind an `@supports` guard. An earlier
  observer-driven reveal set `opacity: 0` and waited, and stranded four whole sections when the
  observer never reported. Anything that hides content must fail toward *visible*.

## Constraints worth knowing

- **MV3 content security policy forbids inline script and inline event handlers on extension pages.**
  Keep JS in `newtab.js` (or another external file) and attach listeners with `addEventListener` —
  an `onclick=` attribute will silently fail to fire.
- **No remote code, and exactly one network destination.** The manifest asks for `search` and
  `storage`; `history` and `https://api.openai.com/*` are *optional*, requested at the click that
  needs them. The only fetch in the extension is `src/answer.js` → `api.openai.com`, with the user's
  own key. There is no Archer server and nothing is proxied. Anything more (favicons, history, topSites) changes the install-time
  consent prompt, so **request a permission in the phase that needs it, never earlier** — the
  roadmap's permissions ledger is the record. `npm run e2e` asserts the current set, so an
  accidental addition fails a test rather than shipping.
- **Nothing leaves the device.** `chrome.storage.local` only; no server, no telemetry, no proxy.
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
