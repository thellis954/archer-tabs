# Archer — brand

The neutral identity called for in `ROADMAP.md` §2.3. Replaces the Atlas/OpenAI styling, which was
fine for a personal unpacked install but is trademark-infringing the moment the extension is shared.

---

## Name

**Archer.**

The extension's whole job is one decision: you type, and it works out what you were aiming at — a
question, or a place to go. Archery is the honest metaphor for that. You nock, you aim, you loose,
and it lands. It also gives the product a letter to build a mark from, which "Ares" doesn't.

Practical checks: no Chrome Web Store collision in the new-tab or launcher category; one word, two
syllables, spellable on first hearing; no trademark entanglement with OpenAI, and it doesn't imply
affiliation the way "Atlas New Tab" did.

**Runners-up**, if you want to swap — it's a find-and-replace plus a new mark:

| Name | The idea | Why it lost |
|---|---|---|
| **Nock** | The notch where arrow meets string — the instant *before* release, which is exactly what a new tab is. The nock's V is also a text caret | Too obscure. Great mark, but you'd explain the name every time |
| **Sagitta** | Latin "arrow", and a constellation — ties archery to navigation | Four syllables. Reads academic |
| **Loose** | The command to release the arrow | Collides with the adjective. Unsearchable |
| **Ares** | Your suggestion | God of *war*, not aim — wrong semantics for a calm new tab page. Also heavily used (the old P2P client) |

---

## The mark

An **A** whose crossbar is a drawn bowstring.

```
legs   M6 26.5 L16 5.5 L26 26.5          viewBox 0 0 32 32
bow    M9.8 18.5 Q16 24.5 22.2 18.5      round caps + joins
```

It's the initial and the instrument in one shape, at a stroke count low enough to survive 16px. The
bowstring bows *downward* — drawn, under tension, about to release. Flip the curve upward and it
collapses into an ordinary rounded-crossbar A; that was tested and rejected.

Six concepts were drawn and rendered before this one: a double chevron read as "upload", a target
with an arrow read as a magnifying glass, a caret-and-dot read as a user avatar, and a literal bow
and arrow read as a Bluetooth glyph. Ambiguity at small sizes killed all of them.

**Stroke weight is per-size**, because a constant weight goes spindly at 16px:

| Size | Stroke | Tile radius | Mark |
|---|---|---|---|
| 128 | 2.4 | 28 | 84 |
| 48 | 2.6 | 11 | 32 |
| 32 | 2.9 | 7 | 22 |
| 16 | 3.3 | 4 | 12 |

**Two-tone vs. one-tone.** In the top bar and on app icons the legs take the foreground color and the
bow takes brass — the accent is what makes it read as a bow rather than a font glyph. The oversized
page mark drops to a single faint tone: at 72px the two-tone version competes with the search box,
which is the actual subject of the page.

**Don't:** rotate it, fill the counter, add a gradient, outline it, set it in a circle, or re-letter
it in a display face. Clear space is one leg-width (≈ 6 units at the 32 viewBox) on all sides.

---

## Palette

Warm neutrals throughout. Atlas is cool white and gray; going warm is the cheapest way to look like a
different product rather than a knock-off, and it suits a name that evokes leather, wood, and brass.

### Light

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#FBF7F0` | cream page ground |
| `--surface` | `#FFFFFF` | search box, hover fills |
| `--border` | `#E8E2D9` | hairlines |
| `--text` | `#141416` | ink — body and titles |
| `--muted` | `#8A8178` | descriptions, placeholder |
| `--faint` | `#D9D2C7` | the oversized page mark |
| `--accent` | `#B45309` | brass — mark, focus, hover |

### Dark

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#141416` | ink ground |
| `--surface` | `#1D1D20` | search box, hover fills |
| `--border` | `#2C2C30` | hairlines |
| `--text` | `#F2EFEA` | warm off-white |
| `--muted` | `#948D84` | descriptions, placeholder |
| `--faint` | `#292927` | the oversized page mark |
| `--accent` | `#F59E0B` | brass lifts to amber to hold on ink |

**Contrast.** `#B45309` on `#FBF7F0` is ≈ 4.9:1 — passes AA for normal text, which is why brass is
safe for hover titles and not just decoration. `#B45309` would fail on ink, hence the amber swap in
dark; verify any new accent pairing before shipping it.

**Accent discipline.** Brass appears on the mark, the focus ring, and hover — nowhere else. An early
draft colored every suggestion title brass and the page turned into a column of shouting; titles are
ink, and only *become* brass on hover.

---

## Typography

System stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`). A new tab page must paint
instantly, and a webfont means either a flash or a blocking load. Neither is worth it.

- **Wordmark** — 15px / 600 / `-0.015em`. The negative tracking is what keeps "Archer" from reading
  as generic UI text.
- **Input** — 16px / 400
- **Rows** — 14px, title 500, description 400

---

## Voice

Plain, short, a little dry. The product is a text box; it should not be enthusiastic about itself.

- Placeholder: **"Ask or type a URL"** — deliberately not "Ask ChatGPT or type a URL". Naming the
  provider in shipped UI implies an affiliation that doesn't exist, and the routing target is a
  setting, not an identity.
- Description: *"A calm new tab page. Ask a question or type a URL — Archer works out which you meant."*
- No exclamation marks. No "supercharge", "AI-powered", or "seamlessly".

---

## Assets

```
assets/mark.svg        ink legs + brass bow      — light contexts, README
assets/mark-dark.svg   cream legs + amber bow    — dark contexts
assets/icon-{16,32,48,128}.png                   — manifest, generated
```

The page renders the mark inline in `newtab.html` rather than via `<img>`, so `currentColor` and the
CSS custom properties can theme it. The `.svg` files exist for documentation and store listing use.

**Regenerating the PNGs** — they're rendered by headless Chromium, so what ships is exactly what
Chrome paints:

```sh
sh tools/genicons.sh
```

Re-run it after any change to the mark geometry or the ink/amber values.
