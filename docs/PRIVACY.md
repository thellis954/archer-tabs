# Archer — privacy policy

Last updated: 2026-08-07. Applies to the Archer Chrome extension, every version.

This file is the canonical text. The Chrome Web Store requires a *hosted* policy URL — publishing
this at `https://archertabs.app/privacy` is website work and is tracked separately; keep the two in
step, and don't submit the listing until that page is live.

---

## The short version

**Archer has no server.** There is no account, no sign-in, no analytics, no telemetry, no crash
reporting and no advertising. Nothing you do in Archer is sent to the people who make it, because
there is nowhere for it to go — no such service was ever built.

Everything Archer remembers is in your own browser's extension storage, on the device you are using.
Uninstalling the extension deletes all of it.

---

## What is stored, and where

All of this lives in `chrome.storage.local` — your browser, your machine. None of it syncs, and none
of it leaves the device except where the next section says so.

| What | Why | Kept until |
|---|---|---|
| Your chosen destination (Search, ChatGPT, Claude, Perplexity, …) | So a new tab opens the way you left it | You change it |
| Prompts you launch from the new tab | To offer them back as rows, and to label a conversation with the prompt that started it | The most recent 200; "Clear prompt history" in settings erases them |
| Pinned and dismissed rows | So the list stays the way you arranged it | You unpin, or dismiss again |
| Saved prompts | The `/slash` library | You delete them |
| Favourites | The tiles under the search box | You remove them |
| Your OpenAI API key, model and budget | To answer on the page, billed to your own OpenAI account | You clear it in settings |
| Weather place and last reading | To draw the weather card without refetching every tab | You turn weather off |
| Whether you dismissed the default-engine hint | So it stays dismissed | Reinstall |

**Archer never reads the contents of pages you visit.** It has no content scripts and no
`host_permissions` on any site you browse.

---

## What leaves the device

Only these, and only for the features you switch on.

**Your search terms, to your own default search engine.** When a prompt is routed to "Search",
Archer calls Chrome's own `chrome.search` API. Chrome sends the query to whatever engine *you* have
set as default. Archer does not choose the engine, does not see the response, and does not have a
search provider of its own.

**Your prompt, to the site you picked.** Choosing ChatGPT, Claude or Perplexity navigates the tab to
that site with your prompt in the address, exactly as if you had typed it there. Their privacy
policies apply from that point, as they would anyway.

**Your prompt and your API key, to OpenAI** — only if you have entered a key and chosen "Answer
here". The request goes from your browser straight to `api.openai.com`. It is not proxied, mirrored
or logged anywhere else, and the key is never transmitted to anyone but OpenAI.
[OpenAI's privacy policy](https://openai.com/policies/privacy-policy).

**A place name and its coordinates, to Open-Meteo** — only if you have set a place for the weather
card. Archer sends the place name you typed to look up its coordinates, then the coordinates to get
a forecast. Nothing identifying you is sent, and **your browser is never asked for its location** —
Archer does not request the `geolocation` permission at all.
[Open-Meteo's privacy policy](https://open-meteo.com/en/terms).

That is the complete list.

---

## Permissions, and what each is for

Archer asks for two permissions when you install it:

- **`search`** — to hand a query to your default search engine through Chrome's own API. This is
  also what the Chrome Web Store requires of a new tab page, so that your choice of search provider
  is respected rather than replaced.
- **`storage`** — somewhere to keep the settings in the table above.

**Everything else is optional and off until you turn it on.** Chrome asks at the moment you enable
the feature, and Archer's settings page lists all of them with an on/off switch:

| Permission | Enabled by | Used for |
|---|---|---|
| `history` | "Show your recent conversations" | Finding `chatgpt.com` conversation addresses so they can be rows. Every other history entry is discarded before it is read |
| `topSites` | "Show top sites" in the + menu | The sites you visit most, as rows |
| `sessions` + `tabs` | "Show recently closed tabs" in the + menu | Reopening a tab you closed. Chrome will not reveal a closed tab's title without `tabs`, which is why this one asks for more |
| `clipboardRead` | "Paste" in the + menu | Reading the clipboard at the moment you choose Paste, and at no other time |
| `api.openai.com` | Saving an API key | Streaming an answer onto the page |
| `api.open-meteo.com`, `geocoding-api.open-meteo.com` | Saving a weather place | The weather card |

Revoking any of them in Archer's settings turns off the feature and nothing else.

---

## Children

Archer is not directed at children and collects nothing from anyone.

## Changes

Material changes will be noted here and in the extension's release notes, with the date at the top
of this file updated. The source is public: every claim above is checkable at
https://github.com/thellis954/archer-tabs.

## Contact

Open an issue at https://github.com/thellis954/archer-tabs/issues.
