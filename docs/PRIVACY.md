# Archer — privacy policy

Last updated: 2026-10-28. Applies to the Archer Chrome extension, every version.

This file is the canonical text. It is published at https://archertabs.app/privacy (`web/privacy.html`), which is the policy URL on the Chrome Web Store listing. Change the two together; `npm run lint` checks that their dates match.

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
| Your chosen destination (Auto, Default engine, Google, ChatGPT, Claude, Perplexity or Answer here) | So a new tab opens the way you left it | You change it |
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

**Your search terms, to your own default search engine.** In Auto and Default engine modes, Archer calls Chrome's own `chrome.search` API. Chrome sends the query to whatever engine *you* have set as default. Archer does not choose the engine, does not see the response, and does not have a search provider of its own.

**Your prompt, to the site you picked.** Choosing Google, ChatGPT, Claude or Perplexity navigates the tab to that site with your prompt in the address, exactly as if you had typed it there. Their privacy policies apply from that point, as they would anyway.

**Files you attach, with your prompt.** If you attach a file, the text Archer extracts from it goes with that one prompt: trimmed to fit the address for a hand-off to a site, or in full to OpenAI for "Answer here". Images are sent only with "Answer here". Attachments are held in memory for the next send and are never stored.

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

Archer's use of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

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
| `history` | "Show your recent conversations" | Finding ChatGPT (`chatgpt.com`, `chat.openai.com`) and Claude (`claude.ai`) conversation addresses from the last 30 days so they can be rows. Every other history entry is discarded before it is read |
| `topSites` | "Show top sites" in the + menu | The sites you visit most, as rows |
| `sessions` + `tabs` | "Show recently closed tabs" in the + menu | Reopening a tab you closed. Chrome will not reveal a closed tab's title without `tabs`, which is why this one asks for more |
| `clipboardRead` | "Paste" in the + menu | Reading the clipboard at the moment you choose Paste, and at no other time |
| `favicon` | Adding a favourite | Reading the icon Chrome already cached for that site, so a favourite shows its own icon rather than its initials. This reads a local store — **no request is made to the site** |
| `api.openai.com` | Saving an API key | Streaming an answer onto the page |
| `api.open-meteo.com`, `geocoding-api.open-meteo.com` | Saving a weather place | The weather card |

Revoking any of them in Archer's settings turns off the feature and nothing else.

---

## This website

archertabs.app (the website, not the extension) measures visits to its home page with two tools.
Vercel Web Analytics is cookieless: it records aggregate, anonymous data only (the page, the
referrer, country, browser, operating system and device type), and a visit is told apart only by a
hash made from the request that is discarded after 24 hours.

The home page also uses Google Analytics. It sets first-party cookies (named `_ga` and
`_ga_<id>`) to tell returning visitors apart, and sends Google your page views, the referrer, your
browser and device details and an approximate location derived from your IP address. Google does
not log or store IP addresses for Google Analytics. We use it only to see how many people visit and
where they come from; we do not use it for advertising and have not enabled Google signals or ad
personalisation. You can block it with any content blocker or Google's
[opt-out add-on](https://tools.google.com/dlpage/gaoptout), and clear the cookies at any time. This
privacy page loads no scripts at all.

None of this is connected to the extension. The extension sends nothing to us, and installing it
adds nothing to these numbers.
[Vercel's Web Analytics privacy notes](https://vercel.com/docs/analytics/privacy-policy) and
[how Google uses data from sites that use its services](https://policies.google.com/technologies/partner-sites).

---

## Children

Archer is not directed at children and collects nothing from anyone.

## Changes

Material changes will be noted here and in the extension's release notes, with the date at the top
of this file updated. The source is public: every claim above is checkable at
https://github.com/thellis954/archer-tabs.

## Contact

Open an issue at https://github.com/thellis954/archer-tabs/issues.
