# Kinfolk design system

The app's look, taken from the school's website (kinfolkedu.com, read 03-Oct-2026): forest and leaf greens, bark brown, night navy and sunshine yellow on warm ivory. A warm serif is used for titles and a rounded sans for everything else. All values live as CSS custom properties in the `:root` block of [`app.css`](../app.css). Open [`docs/design-system.html`](design-system.html) (served by `npm run serve`) to see every token and component rendered from that same stylesheet.

The token names (`--clay`, `--sage`, …) are the original role names from Phase 1. Only their values changed, so no screen code had to change. Use the role, not the colour name, when choosing a token.

## Colour

| Token | Kinfolk name | Hex | Role | Source on the website |
|---|---|---|---|---|
| `--cream` | Ivory | `#FDF8EE` | Page background | ivory `#FFFFF5` / `#FDF7EF` sections |
| `--paper` | Paper | `#FFFFFA` | Cards, bars, inputs | — |
| `--ink` | Night navy | `#1E3446` | Body text | headings `#022A45` / `#033352` |
| `--ink-soft` | Mist | `#56636D` | Secondary text, labels | — |
| `--clay` | Forest | `#355C2E` | Brand primary: primary buttons, links, active nav, logo | headings `#355C2E` |
| `--clay-hover` | Deep forest | `#2A4E15` | Primary hover | headings `#2A4E15` |
| `--clay-soft` | Moss | `#E3EBD8` | Selected nav, own message bubbles | — |
| `--sage` | Leaf | `#7C9B60` | Decorative only: dots, progress bars, the live pulse | text and hill `#7C9B60` |
| `--sage-ink` | Fern | `#4A6B38` | "Good" text, present/paid states | — |
| `--mustard` | Sunshine | `#FDD550` | Highlights, warnings, demo ribbon | "Book a visit" button `#FDD550` |
| `--mustard-ink` | Honey | `#6B4A12` | Text on sunshine tints | — |
| `--sun-deep` | Marigold | `#B8860B` | Sunshine as a dot, bar or border on light surfaces | — |
| `--sky` | Lake | `#2F6585` | Information, events, the bus | not on the site: added for information states |
| `--berry` | Brick | `#A8442C` | Errors, absences, cancelled, overdue | not on the site: added for error states |
| `--bark` | Bark | `#86592B` | Page titles (h1) | headings `#86592B` |
| `--peach` | Peach | `#E49D77` | Accents (sparingly) | navigation bar `#E49D77` |
| `--line` | Sand | `#EAE3D2` | Borders, dividers | — |
| `--tint` | Linen | `#F7F1E3` | Table heads, off days | — |
| `--field` | Stone | `#8A8574` | Input, select and textarea borders | — |

Each `-soft` token is the tint behind its colour's text (badges, banners, calendar chips).

**Contrast** (WCAG, measured): ink on ivory 12.1, Mist on ivory 5.8, white on Forest 7.7, Forest on ivory 7.3, Bark on ivory 5.7, ink on Sunshine 9.1, white on Lake 6.3, white on Brick 6.0, white on Fern 6.1, Brick on its tint 4.8. Sunshine logo on Forest 5.4, Mist on Linen 5.5. **White on Leaf is 3.1 and fails**, so Leaf never carries text; use Fern (`--sage-ink`) for a filled "good" state.

Non-text markers need 3:1 against their surface. Sunshine is only 1.4 on paper, so dots, bars and borders use Marigold (`--sun-deep`, 3.2); Leaf 3.1, Stone input borders 3.7. Section and card borders (`--line`, 1.3) are decorative and never the only edge of a control.

## Type

| Token | Stack | Use |
|---|---|---|
| `--font-display` | Iowan Old Style, Palatino, Book Antiqua, Georgia, serif | `h1` page titles (Bark, weight 600) and the school name in the top bar |
| `--font` | Nunito (vendored, OFL), then system sans | Everything else |

The website's title face is a licensed web font, and its body face (DM Sans) isn't vendored here. The serif stack uses faces already on the phone, so nothing is downloaded. Section headings (`h2`, `h3`) stay in the sans at weight 800 so dense staff screens remain easy to scan.

## Shape and spacing

- Radius `--radius` 14px for cards; 12px for buttons; 999px for pills, chips and badges; the logo mark is a circle.
- Minimum tap target `--tap` 44px.
- Shadow `--shadow`: two soft navy-tinted layers.

## Mark

A sun over rolling hills, echoing the hill on the website's home page. It's an original simple mark, not the school's logo: [`app/icons/icon.svg`](../app/icons/icon.svg) (PNG sizes 180/192/512 are rendered from it). The same SVG, in a circle, is the logo in the app bar and on the sign-in card (`.logo` in `app.css`), so there is one mark to replace. To use the school's own logo, drop the file in and swap the SVG; the PNGs must be re-rendered (`magick -background none -density 300 icon.svg -resize 512x512 icon-512.png`).

## Rules

- Primary action per screen: one Forest button. Secondary actions: outlined paper buttons.
- Status colour is paired with a word (badge text, legend). The one exception is the phone calendar, whose day cells are too small for text: its bars use the full colours (not tints) and the legend explains them.
- Receipts print in black on white ([`src/ui/print.css`](../src/ui/print.css)); brand colour is screen-only.
- Don't add a colour outside this table; add a token first and record its contrast here. The places that must repeat hex values (map, Razorpay, manifest, meta theme colour, icon) are listed in `CLAUDE.md`.
- The public demo uses the school's real name, so its data must look like a demo: the name keeps "(Demo)", fee heads say "(sample)", and every demo receipt is stamped DEMO.
