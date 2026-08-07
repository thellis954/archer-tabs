# Atlas New Tab — Audit & Roadmap

Status: draft, 2026-08-07. Written against v1.0.0 (`manifest.json`, `newtab.html`, `newtab.css`,
`newtab.js`) and a reference screenshot of the real ChatGPT Atlas new tab page.

---

## 0. The thing that reframes this project

**ChatGPT Atlas is being retired.** The reference screenshot carries OpenAI's own banner: *"Atlas
will no longer be available as of August 13 at 6PM PT."* OpenAI is folding Atlas's capabilities into
the redesigned ChatGPT desktop app, a cloud browser for agent tasks, and **its own Chrome
extension**.

Three consequences for this repo:

1. **The clone target is frozen.** There will be no new Atlas features to chase. The screenshot is
   close to the final state of that UI. That's good — it makes "pixel-accurate clone" a finite,
   completable goal rather than a treadmill.
2. **The project's value proposition changes** from "Atlas without switching browsers" to
   **"preserve the Atlas new tab experience after Atlas is gone."** That's a stronger pitch, with a
   real and about-to-be-stranded audience.
3. **OpenAI's own Chrome extension is the competitor**, but it almost certainly will *not* override
   the new tab page — Chrome policy makes NTP override a liability that a first-party AI vendor has
   no reason to take on. The new tab surface is the defensible niche. Own it.

**Recommendation:** proceed, and reposition. Ship Phase 1 before Aug 13 if at all possible, while
people are actively looking for a replacement.

---

## 0.5 Do this today — the address bar needs no code at all

The goal is a Chrome that behaves like Atlas: **ChatGPT is the default search engine in the URL bar,
but typing a URL still just navigates.** That half is already solved, by two mechanisms that ship
today:

**Option A — OpenAI's own extension (recommended).** [ChatGPT search](https://chromewebstore.google.com/detail/chatgpt-search/ejcfepkfckglbgocfkanmcdngdijcgld)
is published by OpenAI, has ~4M users, and does exactly one thing: makes ChatGPT your default search
engine so the omnibox starts a ChatGPT conversation. It also supports `!g <query>` to bounce a single
search to Google. (Last updated Dec 2024, v1.11 — stale, but the mechanism is simple and stable.)

**Option B — a manual custom search engine, no extension.** Chrome Settings → Search engines → Add,
with `https://chatgpt.com/?q=%s` as the URL, then set as default. Caveat: `?q=` does **not** reliably
auto-submit on its own (see Phase 2) — Option A handles submission for you, which is why it wins.

**Chrome's omnibox already does the URL-vs-query disambiguation natively, and does it well.** Type
`github.com` → navigates. Type `how do I rebase` → goes to your default engine. That is precisely the
"ask or type a URL" behavior, for free, with no code and no classifier of ours in the path.

### What this means for this repo

**Scope collapses to the new tab page — and that's the right scope.** OpenAI's extension does not
override the NTP (no first-party AI vendor wants that policy exposure), so the new tab is the piece
nobody is shipping. Build only that, and let the official extension own the omnibox.

The two compose cleanly, and there's a nice consequence: once ChatGPT is your default engine, this
extension's search fallback should call **`chrome.search.query()`**, which routes to *whatever the
user's default engine is* — i.e. ChatGPT. One API call, no hardcoded URL, no fragile auto-submit
hack, and it's the policy-compliant path anyway (§2.2). The correct implementation and the
compliant implementation are the same code.

---

## 1. Reference: what the real page actually contains

From the screenshot, top to bottom:

| Region | Detail |
|---|---|
| Top-left chrome | Sidebar-collapse icon, `ChatGPT` wordmark, then a **`Auto ⌄`** dropdown (the routing mode: let ChatGPT decide chat-vs-search) |
| Center | OpenAI knot logo, light gray (`#d5d5d5`-ish), large |
| Omnibox | Rounded pill ~795px wide, `+` at left, placeholder **"Ask ChatGPT or type a URL"**, mic glyph at right |
| Suggestions | Four rows, 44px pitch, each: favicon-ish icon, **blue link-colored title**, then `— gray description`, truncated with ellipsis |

**The single most important detail:** the suggestion rows are *not* static shortcuts. They are the
user's **recent ChatGPT conversations**, where the title is the conversation title and the
description is the opening prompt text:

> 🔭 **Evaluate Claude vs rivals** — I want you to compare Claude AI tools (browser, VS Code, and code assistance) wit…
> 📰 **News about Air Quality Alerts** — Sentence 1: Reports suggest air quality alerts are tied to Canadian wildfires. Se…
> 🗂 **Group ExtremeKartz GitHub activity** — I want you to group ExtremeKartz GitHub activity by repository and pull r…

(The first row, *"Import from another browser — Passwords, Bookmarks, History and more"*, is an
onboarding affordance, not a conversation.)

The current build's three hardcoded rows (ChatGPT / GitHub / Notion) are placeholders standing
where the real feature goes. **Recent-conversation rows are the heart of the clone**, and §3 covers
how to source them legitimately.

---

## 2. Audit of v1.0.0

### 2.1 Correctness — `looksLikeURL()` is wrong in ways users will hit daily

`newtab.js:32` classifies with `/^[^\s]+\.[^\s]+/`. It is unanchored at the end, so it only inspects
the *first* token:

| Input | Current behavior | Should be |
|---|---|---|
| `vue.js tutorial` | → `https://vue.js tutorial` (broken navigation) | prompt |
| `node.js` | → `https://node.js` (DNS failure) | prompt |
| `3.5 vs 4 pricing` | → `https://3.5 vs 4 pricing` | prompt |
| `e.g. what is RAG` | → `https://e.g. what is RAG` | prompt |
| `localhost:3000` | ✅ URL, but forced to `https://` → fails on plain-HTTP dev servers | `http://` |
| `192.168.1.1` | ✅ URL by accident (dot rule) | URL, `http://` |

Two root causes: **(a)** any whitespace in the input should immediately disqualify it as a URL, and
**(b)** a dot is not a TLD. Fix:

```js
const SCHEME    = /^https?:\/\//i;
const LOCALHOST = /^localhost(:\d+)?([/?#]|$)/i;
const IPV4      = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/;

function classify(raw) {
  const value = raw.trim();
  if (!value)               return { kind: "empty"  };
  if (SCHEME.test(value))   return { kind: "url", url: value };
  if (/\s/.test(value))     return { kind: "prompt" };          // (a) whitespace ⇒ never a URL
  if (LOCALHOST.test(value) || IPV4.test(value))
                            return { kind: "url", url: "http://" + value };

  const host   = value.split(/[/?#]/)[0];
  const labels = host.split(".");
  if (labels.length < 2)    return { kind: "prompt" };
  const tld = labels.at(-1).toLowerCase();
  if (!IANA_TLDS.has(tld))  return { kind: "prompt" };          // (b) real TLD list, not "has a dot"
  return { kind: "url", url: "https://" + value };
}
```

Bundle the IANA TLD list (~1.4k entries, ~10 KB gzipped) — this is what browser omniboxes do, and it
is the only way `claude.ai` resolves as a URL while `node.js` resolves as a prompt. Add explicit
overrides for the genuinely ambiguous cases: **⌘/Ctrl+Enter forces prompt, Shift+Enter forces URL.**

This function is pure and total — it is the one piece of this codebase that genuinely warrants unit
tests. Table-driven, ~40 cases, Vitest.

### 2.2 Policy — hardcoded Google is both a bug and a store violation risk

`newtab.js:28` sends every non-URL to `google.com/search`. That is the opposite of the product's
whole point (you want ChatGPT), *and* it's a compliance problem: Chrome Web Store program policy
states that extensions providing a modified search experience on a new tab page which **do not
respect the user's choice of search provider**, or fail to use official Chrome search APIs
(`chrome.search`), are in violation.

Both problems have the same one-line fix:

```js
chrome.search.query({ text: value, disposition: "CURRENT_TAB" });
```

This routes to whatever the user actually set as default — which, per §0.5, is ChatGPT. Correct
behavior and compliant behavior turn out to be identical here, and it's less code than what's there
now.

Separately: Chrome is rolling out (2026) a default block on **policy-installed** NTP/search-override
extensions. This targets force-installed enterprise deployments, **not** manual user installs, so it
doesn't threaten this project — but it's a reason to never ship an enterprise-push distribution.

### 2.3 Trademark — do not ship OpenAI's marks

A faithful clone wants the OpenAI knot logo, the `ChatGPT` wordmark, and the exact
*"Ask ChatGPT or type a URL"* placeholder. For your own unpacked install, that's fine. For a public
Chrome Web Store listing it is trademark infringement and trips the store's impersonation policy —
the likeliest outcome is takedown, and the name "Atlas New Tab" compounds it.

**Resolved — see `docs/BRAND.md`.** The project is now **Archer**, with its own mark (an *A* whose
crossbar is a drawn bowstring), a warm cream/ink/brass palette, and the placeholder *"Ask or type a
URL"*. The two-skin idea was dropped: maintaining a "faithful" mode meant keeping infringing assets
in the tree for no real gain, and the neutral identity is the better-looking of the two anyway.

### 2.4 The focus problem (the hard one)

`autofocus` on `newtab.html:22` will lose to Chrome's address bar. When you press ⌘T, Chrome puts
the caret in the omnibox and an NTP-override page cannot reliably steal it. This is *the* structural
compromise of every NTP extension, and it's the biggest fidelity gap versus real Atlas, which owns
its own browser chrome and has no such constraint.

**§0.5 defuses most of this.** If the omnibox default engine is already ChatGPT, then ⌘T-then-type
lands in the address bar and *still* reaches ChatGPT — the fast path works whether or not our page
ever gets focus. The page-level input matters for the deliberate case: you're looking at the new tab,
you want the Atlas surface, you click and type.

Remaining mitigations:
- A `keydown` listener on `document` that forwards the first printable character into the input, so
  typing works if focus does land on the page.
- Document it honestly in the store listing. Users who've hit it before will respect the candor.

Skip the `chrome.omnibox` keyword idea — a `gpt ` prefix is strictly worse than just having ChatGPT
as the default engine, and it's redundant once §0.5 is in place.

### 2.5 Everything else

| # | Finding | Where |
|---|---|---|
| 1 | Suggestion rows and the `+` / mic buttons have no listeners — pure decoration | `newtab.html:24-56` |
| 2 | `♩` (musical note) stands in for a mic; `◎` for the OpenAI logo. Screen readers announce "quarter note" | `newtab.html:14,32` |
| 3 | No `aria-label` on any icon button, no `<label>` for the input, no focus-visible styling | `newtab.html`, `newtab.css` |
| 4 | No dark mode; no `prefers-color-scheme` | `newtab.css:6` |
| 5 | Fixed `795px` / `760px` widths, fixed `155px` top pad — unusable in a narrow window, misaligned in a short one | `newtab.css:33,73,20` |
| 6 | `manifest.json` has no `icons` key — required for a Web Store listing | `manifest.json` |
| 7 | Navigation via `window.location.href` replaces the NTP in session history; `chrome.tabs.update` is cleaner | `newtab.js:21,28` |
| 8 | No `<meta name="color-scheme">`, so there's a white flash before CSS applies on dark setups | `newtab.html:4` |
| 9 | Missing keyboard model entirely: no ↑/↓ through suggestions, no Esc to clear, no `/` to focus | — |
| 10 | No tests, no linter, no CI | — |

Nothing here is a security defect today — there's no `innerHTML`, no remote code, no permissions.
That changes the moment §3 lands: **all history-derived text must be rendered with `textContent`,
never `innerHTML`.** Conversation titles are attacker-influenceable (anyone can send you a link that
sets a page title).

---

## 3. "Require ChatGPT login to pull actual ChatGPT data" — what's actually possible

This is the most important part of the brief, and it needs a straight answer: **the specific thing
you asked for cannot be built as described.** Here's the evidence and the workaround, which I think
gets you ~90% of the intended experience.

### 3.1 What OpenAI actually offers

| Mechanism | Grants | Gives chat history? |
|---|---|---|
| **Sign in with ChatGPT** (OAuth 2.0, launched 2025) | Name, email, profile picture. Identity only | ❌ No. Also gated behind a developer application/partner program, and explicitly does not grant model usage on the user's plan |
| **Platform API key** (`api.openai.com`) | Model inference, billed to a developer account | ❌ No — `api.openai.com` and `chatgpt.com` are different account namespaces. Your API key cannot see your ChatGPT conversations |
| **Codex / ChatGPT-linked tokens** | Charging model calls to a ChatGPT subscription, for Codex CLI/IDE | ❌ No conversation-history scope |

There is **no public, sanctioned API for ChatGPT conversation history, memories, or ChatGPT search
history.** I checked OpenAI's help center and developer auth docs; no such scope exists.

### 3.2 The route not to take

`chatgpt.com/backend-api/conversations` is the internal endpoint the web app itself calls. An
extension with host permissions on `chatgpt.com` could ride the user's session cookie and read it.

**Don't.** It is undocumented and changes without notice; it reads a session credential in a way that
Chrome Web Store review treats as abuse and that OpenAI's terms prohibit; and it will get the
extension pulled and possibly the account actioned. It also breaks the moment they rotate an
endpoint — you'd be shipping a product whose core feature fails on OpenAI's schedule, not yours.

### 3.3 The route to take — same UI, legitimate sourcing

Reconstruct the recent-conversations list from **two sources you're entitled to**:

**Source A — `chrome.history`, for titles and links.** Every ChatGPT conversation the user opens is a
visit to `https://chatgpt.com/c/<uuid>`, and Chrome records the page title, *which is the
conversation title*:

```js
const visits = await chrome.history.search({
  text: "chatgpt.com/c/",
  startTime: Date.now() - 30 * 864e5,
  maxResults: 200,
});
const convos = visits
  .filter(v => /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{36}/.test(v.url))
  .filter(v => v.title && v.title !== "ChatGPT")   // drop pre-rename visits
  .sort((a, b) => b.lastVisitTime - a.lastVisitTime);
```

This needs only the `history` permission — no OpenAI credential is touched. Deduplicate by
conversation UUID and you have the exact list the screenshot shows, clickable straight back into the
conversation.

**Source B — the extension's own launch log, for the description text.** Every prompt launched
*through* the new tab is recorded locally in `chrome.storage.local`. When a launch is followed by a
visit to a `/c/<uuid>` URL, bind them. Now each row renders **blue conversation title — gray original
prompt**, which is precisely the Atlas layout.

Rows with a title but no bound prompt (conversations started elsewhere) degrade gracefully to
title-only. Rows with a prompt but no title yet show the prompt alone.

**What you lose versus true API access:** message bodies, memories, and conversations that predate
the extension's install or were opened on another device. **What you gain:** it works today, needs no
partner approval, survives OpenAI's internal refactors, and is defensible in store review.

### 3.4 Where login *is* worth having

- **Identity-only Sign in with ChatGPT** — avatar + name in the corner. Cosmetic. Requires partner
  approval. **Skip it**; it buys nothing functional.
- **User-supplied Platform API key** — this is the one worth building. It unlocks something Atlas
  itself never had: **answers streaming inline on the new tab page without navigating away** (§4,
  Phase 4). The user pastes their own key, it lives in `chrome.storage.local`, they pay their own
  tokens, and the value is immediate and honest. Never proxy it through a server you run.

---

## 4. Roadmap

Sequenced so each phase ships something usable on its own.

### Phase 0 — Correctness & compliance ✅ **done**
- ✅ `classify()` + IANA TLD list replaces `looksLikeURL` (§2.1)
- ✅ `chrome.search.query()` for the web-search fallback (§2.2)
- ✅ ⌘/Ctrl+Enter forces prompt; Shift+Enter forces URL; Esc clears
- ✅ `http://` for localhost, IPv4 and IPv6 literals
- ✅ `manifest.json`: `icons`, `permissions: ["search"]`
- ✅ CI on PR — lint + unit tests

**Two security holes found during implementation that this audit had missed:**
- `javascript:` / `data:` / `file:` URLs reached `location.href`. The new tab page is a privileged
  extension origin, so `javascript:alert(1)` would have executed *in that origin*. Only `http(s)` is
  navigable now; every other scheme is treated as a prompt.
- `google.com@evil.com` passed the "has a valid TLD" test and navigated to **evil.com** with a
  trustworthy-looking prefix. Anything with userinfo in the authority is now refused.

**Deviations from the plan, deliberately:**
- **node's built-in test runner instead of Vitest, and a purpose-built linter instead of
  ESLint + Prettier.** Both keep the repo at zero dependencies — no `node_modules`, no lockfile, no
  supply chain — which matters more here than generic style rules over one small source file.
  `tools/lint.js` checks what actually breaks this project: MV3's CSP rules, HTML injection sinks,
  the CSS-token discipline, and manifest/filesystem agreement.
- **The Playwright e2e harness was pulled forward from Phase 6.** It drives a real Chromium with the
  unpacked extension loaded, so every later phase gets real verification instead of assertions about
  mocks. Note for whoever touches it: Playwright's default headless mode is the *headless shell*,
  which silently ignores `--load-extension`; `channel: "chromium"` is required.

### Phase 1 — Pixel-accurate clone ✅ **done**
- ✅ Top-left chrome: sidebar icon, wordmark, `Auto ⌄` dropdown (wired in Phase 2)
- ✅ Inline SVG throughout; the neutral Archer mark, not `◎`/`♩`
- ✅ Type scale, hover/active/focus-visible states, 44px suggestion pitch, ellipsis truncation
- ✅ Dark mode via `prefers-color-scheme` + `<meta name="color-scheme">`
- ✅ Fluid width, top offset in `vh` with a `px` floor
- ✅ a11y pass: labels, roles, aria, visible focus rings, contrast

**The shipped icons were blank, and had been since they were generated.** Every
`extension/assets/icon-*.png` was roughly 60% transparent — the extensions bar and the new-tab
settings entry drew almost nothing. The cause was in `tools/genicons.sh`: headless Chromium clips
its paint to about *(window height − 88px)* while still writing a screenshot the full height of the
`--window-size`, so a 16×16 window painted 0 usable rows and a 128×128 window painted 40. It is not
a paint race — `--headless=new` and `--virtual-time-budget` produce byte-identical output — and no
flag fixes it, because the screenshot canvas is sized by the window rather than by the caller.

- **`tools/genicons.sh` → `tools/genicons.mjs`, on Playwright** (deviation from "tooling is
  dependency-free"). A driver can size the canvas; a browser window cannot. Playwright is already
  the e2e dependency, icon regeneration is a rare maintainer task, and CI does not run either.
- **`tools/lint.js` now reads the icon pixels** (via a small dependency-free PNG reader,
  `tools/png.js`) and fails on a canvas less than 70% painted, a transparent bottom edge, or a
  missing cream/brass stroke. A truncated PNG is still a valid PNG of the right dimensions, which is
  exactly why this shipped unnoticed for as long as it did.

**Other deviations from the plan, deliberately:**
- **The mic button is gone; the right-hand control is now a real submit button.** The reference has
  a mic, but no roadmap phase owns one, and voice input would cost a permission and a feature. A
  dead button is worse than no button, and submitting is the page's actual job — so the slot went to
  the thing the page already does. It is `disabled` until there is something to send. Voice input is
  parked in §4.5.
- **Brass extends to the send control.** `docs/BRAND.md` had restricted the accent to the mark,
  focus and hover; the primary action of the page is the one other place it earns its keep. An
  outlined glyph there read as more decoration.
- **`--muted` was failing WCAG AA and is now `#78706A`.** The old `#8A8178` is **3.58:1** on cream —
  and it is the placeholder and every row description, i.e. normal-size body text needing 4.5:1. The
  dark-mode value was always fine (5.6:1). `npm run e2e` now computes both from the painted pixels
  in both themes, so a token cannot regress in one theme only.
- **`npm run shots`** (`tools/shots.mjs`) renders the page in both themes, at two widths, plus a
  filled-input/hovered-row state — the states the resting page does not show. Added because the
  suggestion rows were misaligned under the search box and nothing but a render would have said so.

### Phase 2 — Real routing (~0.5 day) 🔴 this is the product, and it got much smaller
Makes "Ask ChatGPT or type a URL" true, replacing the Google fallback. §0.5 does most of the work.
- `Auto` mode: URL → `chrome.tabs.update`; prompt → `chrome.search.query()` → the user's default
  engine → ChatGPT. **That's the entire routing story.** No hardcoded ChatGPT URL, no content script.
- Dropdown modes `Auto` / `ChatGPT` / `Search`, persisted in `chrome.storage`
- First-run check: if the default engine isn't ChatGPT, show a dismissible one-line nudge linking to
  OpenAI's extension. Detecting this is imprecise — treat it as a hint, never a blocker
- Bind the resulting `/c/<uuid>` back to the launched prompt (§3.3 Source B)

**Deferred, possibly forever — the direct-handoff content script.** For users who explicitly pick
`ChatGPT` mode while running a *different* default engine, we'd need `https://chatgpt.com/?q=<q>`
plus a content script to actually submit it (`?q=` does not natively auto-submit): wait for the
composer via MutationObserver, set the value through React's native setter, dispatch `input`, submit.
It is the most brittle code in the whole plan — it breaks whenever OpenAI reships their frontend —
and §0.5 makes it unnecessary for the common case. **Build it only if that mode proves popular, and
always fall back to leaving text in the composer rather than a dead button.**

### Phase 3 — History & recall (~3 days) 🟡 the biggest gap vs. Atlas
Where the suggestion rows become real, and where you start to exceed the original.
- Recent conversations from `chrome.history` + local launch log (§3.3), `textContent` only
- Local prompt history with fuzzy search — type to filter, ↑/↓ to select, Enter to relaunch
- Pin conversations to the top; dismiss rows
- **Onboarding row** mirroring Atlas's "Import from another browser"
- A real empty state for first run

### Phase 4 — Inline answers (~3 days) 🟡 exceeds Atlas
- BYO Platform API key, stored locally, never proxied (§3.4)
- Stream the answer directly onto the new tab; "Continue in ChatGPT" hands off to a full conversation
- Model picker, token/cost counter, per-session spend cap
- Degrades cleanly to Phase 2 navigation when no key is set

### Phase 5 — Power features (~1 week) 🟢 the differentiators
Ordered by my estimate of value per unit of work:
1. **Working `+` button** — attach current tab URL, page selection, or clipboard as prompt context. The single most-missed affordance in the current build.
2. **Prompt library** — saved prompts with `{{variables}}`, invoked by `/slash` in the omnibox.
3. **Multi-target routing** — Tab to cycle ChatGPT / Claude / Perplexity / default search; same query, chosen destination.
4. **Top sites & recently-closed tabs** — `chrome.topSites`, `chrome.sessions`. Atlas's NTP has neither, and a new tab page is exactly where they belong.
5. **Local prompt analytics** — what you actually ask, computed on-device.
6. **Export to Markdown** — prompt history out as `.md`; a natural drop into an Obsidian vault.

### Phase 6 — Ship (~2 days) 🟢
- ~~Neutral brand skin~~ ✅ done — Archer, `docs/BRAND.md`. Remaining: store screenshots, listing
  copy, privacy policy ("all data stays on your device")
- Per-permission opt-in with plain-language rationale — request `history` only when the user enables
  the conversations feature, not at install
- Playwright smoke test against a real Chromium profile with the extension loaded
- Tag `1.0.0` → publish

### Engineering foundation
Stay dependency-light and zero-framework — this UI does not need React. Introduce **esbuild** at
Phase 2 (the content script and TLD list make bundling worthwhile), **Vitest** at Phase 0.
Split `newtab.js` into `src/classify.js`, `src/router.js`, `src/history.js`, `src/render.js` at Phase 1
— it stops being one file the moment Phase 3 lands.

### Permissions ledger
Each one costs install-time trust; add only when its phase needs it.

| Permission | Phase | For |
|---|---|---|
| `search` | 0 | Respect the user's default engine |
| `storage` | 2 | Mode, launch log, preferences |
| `tabs` | 2 | Cleaner navigation than `location.href` |
| `history` | 3 | Recent ChatGPT conversations |
| `topSites`, `sessions` | 5 | Tiles, recently-closed |
| ~~`host_permissions: chatgpt.com`~~ | — | Deferred with the content script (Phase 2). Avoiding this one is worth real trust — host permissions on chatgpt.com is the scariest prompt in the list |

---

## 4.5 Parked ideas

Raised while implementing; not scheduled. Revisit after Phase 6.

| Idea | Why it might be worth it |
|---|---|
| **Bang prefixes** — `!g`, `!c`, `!p` to force Google / Claude / Perplexity for one query | OpenAI's own extension ships `!g`, so the gesture is already familiar. Cheaper than the Phase 5 multi-target UI and covers most of its value |
| **Switch-don't-duplicate** | If the URL you typed is already open in another tab, focus that tab instead of loading a second copy (`chrome.tabs.query`). Small, and quietly excellent |
| **Paste-and-go** | Pasting a URL into an empty box could offer one-keystroke navigation without Enter |
| **"Ask again elsewhere"** | After a search, re-run the same query against a different target from the new tab, without retyping |
| **Settings import/export** | A JSON blob of modes, pins, and prompt library. Makes a machine migration painless — and this project exists because of one |
| **Localisation** | The UI is ~12 strings. Cheap to externalise now, expensive after Phase 5 |
| **Voice input** | The mic the reference has, made real via the Web Speech API. Dropped in Phase 1 rather than shipped dead; it needs a microphone permission and a whole interaction model, so it is a feature, not a glyph |

## 5. Open questions

1. **Public listing, or personal install?** This drives §2.3 (branding), §2.2 (policy rigor), and
   whether Phase 6 exists at all. It's the one answer that changes the plan's shape. If this is
   purely a personal Atlas-migration tool, Phases 0–3 are the whole project and everything after is
   optional.
2. **Firefox?** Its `chrome_url_overrides.newtab` equivalent behaves differently and its NTP focus
   model is friendlier. Worth knowing before the Phase 1 CSS hardens.
3. **Is Phase 4 (inline answers) worth it to you**, given it asks users to bring a paid API key? It's
   the most technically interesting phase and the clearest way to beat the original — but it's also
   the one with a real adoption cost.

---

## Sources

- [Introducing ChatGPT Atlas — OpenAI](https://openai.com/index/introducing-chatgpt-atlas/)
- [ChatGPT Atlas Release Notes — OpenAI Help Center](https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes)
- [OpenAI is shutting down Atlas — TechCrunch](https://techcrunch.com/2026/07/09/openai-is-shutting-down-atlas-but-its-ai-browser-ambitions-are-still-growing/)
- [OpenAI is discontinuing ChatGPT Atlas — 9to5Mac](https://9to5mac.com/2026/07/09/openai-is-discontinuing-chatgpt-atlas-its-standalone-desktop-browser/)
- [Sign in with ChatGPT — OpenAI Help Center](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
- [Authentication — ChatGPT Learn](https://learn.chatgpt.com/docs/auth)
- [ChatGPT search extension (publisher: OpenAI) — Chrome Web Store](https://chromewebstore.google.com/detail/chatgpt-search/ejcfepkfckglbgocfkanmcdngdijcgld)
- [ChatGPT Search — OpenAI Help Center](https://help.openai.com/en/articles/9237897-chatgpt-search)
- [Extensions quality guidelines FAQ — Chrome for Developers](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq)
- [Troubleshooting Chrome Web Store violations — Chrome for Developers](https://developer.chrome.com/docs/webstore/troubleshooting)
- [Chrome prepares default block for NTP/search-hijacking extensions — gHacks](https://www.ghacks.net/2026/08/03/google-chrome-prepares-default-block-for-extensions-that-hijack-the-new-tab-page-or-search-engine/)
