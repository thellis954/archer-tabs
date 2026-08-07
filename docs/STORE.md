# Chrome Web Store listing

The copy to paste into the developer dashboard, plus the assets and the answers to the data-use
declarations. Keep this in step with what actually ships — a listing that overstates is a takedown
risk, and one that understates loses the install.

---

## Name

```
Archer — new tab
```

Under the 45-character limit. Not "Atlas New Tab": naming another company's discontinued product in
a listing title is an impersonation-policy problem as well as a trademark one (`docs/BRAND.md`).

## Summary (132 characters max)

```
Ask a question or type a URL. Archer works out which you meant, and keeps your new tab quiet.
```

## Category

**Productivity** → *Workflow & Planning*. Not "Search Tools" — Archer does not replace your search
engine, it respects it, and the store reads that category as a search-hijack signal.

## Description

```
Archer replaces Chrome's new tab with one box.

Type a question and it goes wherever you choose — your own search engine, ChatGPT, Claude,
Perplexity, or straight onto the page as a streamed answer if you bring your own OpenAI key. Type an
address and you simply land there. Archer works out which you meant, and gets out of the way.

A clock, the weather, and the handful of sites you open without thinking.

WHAT IT DOES
• One box: ask or navigate, and it tells the difference — "node.js" is a question, "claude.ai" is a
  place. It uses the real list of top-level domains to decide, the way the address bar does.
• Pick a destination: Search, ChatGPT, Claude or Perplexity, one click above the box.
• Pick up where you left off: recent conversations and past prompts as rows you can filter by
  typing, pin, or dismiss.
• Saved prompts with fill-in-the-blanks, opened by typing "/".
• A clock, greeting and date; a weather card; a favourites bar.
• Answers on the page, streamed from your own OpenAI key, with a daily token budget.
• Light and dark, and a full keyboard model.

WHAT IT DOESN'T DO
Archer has no server, no account, no analytics and no ads. Everything it remembers is in your own
browser and is deleted when you uninstall. It does not read the pages you visit — it has no content
scripts and no access to any site you browse.

It installs asking for two things: permission to use your default search engine, and somewhere to
keep your settings. Everything else — history, top sites, closed tabs, clipboard, weather, the
OpenAI API — is off until you turn it on, is explained in plain language before you do, and can be
turned back off from Archer's settings at any time.

Your default search engine stays yours. Archer routes searches through Chrome's own API to whatever
engine you have already chosen, rather than substituting one of its own.

Open source, GPL-3.0: https://github.com/thellis954/archer-tabs
Privacy policy: https://archertabs.app/privacy
```

## Privacy policy URL

```
https://archertabs.app/privacy
```

Required for any extension that handles user data. **This page does not exist yet** — the site is
worked on separately. `docs/PRIVACY.md` is the canonical text to publish there. The listing cannot
be submitted until the URL resolves.

## Single purpose

```
Replace the new tab page with a search box that routes what you type to the destination you chose.
```

The store requires a single stated purpose, and everything on the page has to serve it. The clock,
weather and favourites are furniture on that page, not separate products.

## Permission justifications

Paste these against each permission in the dashboard. They must match the code.

| Permission | Justification |
|---|---|
| `search` | Hands the query to the user's own default search engine through Chrome's API, so their choice of provider is respected rather than replaced. |
| `storage` | Keeps the user's settings, saved prompts, favourites and prompt history on their own device. Nothing is sent anywhere. |
| `history` *(optional)* | Requested only when the user enables "recent conversations". Used to find `chatgpt.com` conversation addresses so they can be listed on the new tab. Every other history entry is discarded before it is read. |
| `topSites` *(optional)* | Requested only when the user enables top sites. Lists their most-visited sites as rows on the new tab. |
| `sessions`, `tabs` *(optional)* | Requested together, only when the user enables "recently closed tabs", so a closed tab can be reopened. `sessions` alone does not expose a closed tab's title or URL. |
| `clipboardRead` *(optional)* | Requested only when the user chooses "Paste" in the + menu, and read only at that moment. |
| `host: api.openai.com` *(optional)* | Requested only when the user saves their own OpenAI API key. The new tab page calls the API directly with that key; nothing is proxied through a third party. |
| `host: *.open-meteo.com` *(optional)* | Requested only when the user sets a place for the weather card. Sends the place name and its coordinates; no user identifier and no browser geolocation. |

**Remote code:** none. Every script is in the package; there is no `eval`, no injected script, and no
code fetched at runtime.

## Data-use disclosures

| Question | Answer |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | **Yes** — the user's own OpenAI API key, stored locally and sent only to OpenAI |
| Personal communications | No |
| Location | No |
| Web history | **Yes** — read locally to list ChatGPT conversations; never transmitted |
| User activity | No |
| Website content | No |

And the three certifications:

- ✅ Not being sold to third parties, outside of approved use cases
- ✅ Not being used or transferred for purposes unrelated to the item's single purpose
- ✅ Not being used or transferred to determine creditworthiness or for lending purposes

## Assets

Generated by `npm run store`, into `store/`:

| Asset | Size | Notes |
|---|---|---|
| Screenshots ×5 | 1280×800 | The store shows the first one largest; lead with the whole page |
| Small promo tile | 440×280 | Required |
| Marquee promo tile | 1400×560 | Optional; only shown if the store features you |
| Icon | 128×128 | `extension/assets/icon-128.png` |

Screenshot order, chosen so the first frame explains the product without a caption:

1. The whole page, light — clock, pills, box, favourites
2. The whole page, dark
3. Destination pills with the menu open — "the same query, wherever you want it"
4. Recent conversations and prompt rows — "pick up where you left off"
5. The settings page's permissions panel — "off until you turn it on"

## Before submitting

- [ ] `npm run check` and `npm run e2e` both green
- [ ] `manifest.json` version bumped past the published one
- [ ] Load unpacked from a clean profile and click every control once
- [ ] Open each of the four icon PNGs and look at them (they shipped blank once — see Phase 1)
- [ ] `npm run store` regenerated after any UI change
- [ ] Privacy policy live at the URL above (site work — not in this repo's extension folder)
