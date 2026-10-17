# Owed brand

## The mark

An **O** drawn as a ring (a coin, an account) with an **arrow landing in it from above**. The arrowhead fuses
with the lower arc, so at favicon size the glyph reads as a check inside a coin: you were owed, now you are paid.
Single-weight strokes, round caps, geometric. It is built on a 32 x 32 grid with 2 px bleed:

| Element | Geometry |
|---|---|
| Ring | centre (16, 17.8), radius 9, stroke 2.6 |
| Arrow | `M16 4.8v19.8M12.2 20.8 16 24.6l3.8-3.8`, stroke 2.6, round caps and joins |
| Tile | 32 x 32, corner radius 9 (28 %), vertical gradient `#12a37c` → `#0f7b5f`, 0.5-unit inner highlight `rgb(255 255 255 / 0.18)` fading out by 60 % |

The same numbers live in `web/components/wordmark.tsx`, `web/app/icon.svg`, `web/components/marketing/og.tsx`,
`web/components/og-card.tsx` and `web/public/brand/*.svg`. Change them together.

## Palette ("settled green": the colour of money that has landed)

| Token | Light | Dark | Use |
|---|---|---|---|
| accent | `#0f7b5f` | `#3ddc9d` | links, buttons, the Paid state |
| accent-strong | `#12a37c` | `#19c98a` | tile top, emphasis |
| paper / bg | `#f8f8f5` | `#0a0b10` | page background |
| ink / fg | `#0e0f14` | `#f4f4f1` | type |
| muted | `#5b5e6b` | `#a3a6b3` | secondary type |
| gradient | `#3ddc9d` → `#12a37c` → `#0f7b5f` | same | marketing gradients, `.text-gradient` |

Tokens are defined once in `app/globals.css`; components use the Tailwind names (`bg-accent`, `text-ink-fg`, ...).

## Files

| File | What |
|---|---|
| `public/brand/owed-mark.svg` | tile + white mark (any size; viewBox 32) |
| `public/brand/owed-mark-mono.svg` | strokes only in `currentColor`, for the header on ink and for print |
| `public/brand/owed-wordmark.svg` | tile mark + "Owed" drawn as monoline geometric paths (no font needed) |
| `public/brand/owed-mark-512.png`, `owed-mark-1024.png` | raster tile for stores, social, decks |
| `public/brand/owed-logo-sheet.png` | 1600 x 900 presentation sheet: sizes, mono, wordmark, palette |
| `web/app/icon.svg`, `public/favicon.ico`, `public/apple-touch-icon.png` | browser and home-screen icons (the 16 px ICO slice uses a 3.0 stroke so the ring survives the grid) |
| `web/components/wordmark.tsx` | `Mark({ size, variant: "tile" \| "mono", id })` and `Wordmark({ href, size })` |

## Usage rules

- **Clear space**: at least two stroke widths (2 x 2.6 grid units, i.e. 16 % of the tile side) on every side.
- **Minimum size**: 16 px. Below 24 px prefer the tile; the mono mark needs 20 px or more.
- **Mono on ink**: on dark or photographic backgrounds use the mono mark in `ink-fg` (`#f4f4f1`) or mint (`#3ddc9d`).
  On paper the mono mark is ink or accent. Never outline, shadow or add effects to it.
- **Never recolour the tile.** The tile is always the settled-green gradient with a white mark; no indigo, no flat fills,
  no gradients inside the strokes. For single-colour contexts use the mono variant.
- Do not rotate, skew, add a second arrow, or set the word "Owed" in another typeface inside the lockup. In UI text
  the wordmark is Geist semibold at `tracking-[-0.02em]`.
