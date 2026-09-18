# Gomez design system — premium black

Black is the environment. White is the information. Electric blue is a signal.

## Files
- `app/globals.css` — tokens (`:root`) + the ported base styles (all colors tokenised).
- `app/theme-black.css` — the Intelligence OS layer: sidebar, top bar, buttons, dots, inputs, rows, modals, chat.
- `app/theme-black-pages.css` — page layouts (Mission Control briefs, Jobs roster, Follow-Through queue, Connections rows).
- `scripts/recolor-black.py` — the one-off migration that mapped legacy navy/blue hex values to tokens.

## Tokens
| Token | Value | Use |
| --- | --- | --- |
| `--background` | #050505 | page |
| `--sidebar` | #070707 | sidebar |
| `--surface-1/2/3` | #0A0A0C / #0E0E11 / #111114 | subtle elevation; never pure black stacks |
| `--surface-hover` | #151518 | hover |
| `--input` | #0C0C0E | inputs, composer |
| `--text-primary/secondary/muted/faint` | #F5F5F7 / #A1A1AA / #7A7A83 / #4C4C53 | muted ≥ 4.5:1 on background; faint only for decoration |
| `--border` / `--border-strong` | #1B1B1F / #29292E | hairlines / inputs |
| `--accent` / `--accent-bright` | #4DA3FF / #78BEFF | selected, active, primary action, AI working, focus |
| `--accent-glow(-strong)` | rgba(77,163,255,.12/.18) | focus rings, running state |
| `--success` / `--warning` / `--danger` | #58D39D / #E4B669 / #E57777 | status dots + text only |
| `--radius-sm` / `--radius` / `--radius-lg` | 5 / 8 / 12 px | |

Legacy aliases (`--bg`, `--panel`, `--card`, `--muted`, `--text`, `--accent-dim`) map onto the tokens above.

## Rules
- ~95% black/charcoal/gray/white, ~5% blue. Blue means something: `.nav-item.active::before`, `.button.primary`, `.filter-tab.active`, focus rings, `.mode-badge.live`, running states, the ✦ button glow.
- Status is a 6px dot + text (`.pill.ok|amber|danger|neutral|info`), never a filled badge; never color-only (label always present).
- Prefer hairline rows (`border-bottom: 1px solid var(--border)`) over cards. Cards only group genuinely related content (modals, callouts, the neural graph).
- Buttons: primary (blue, one per context), secondary (surface-2 + strong border), ghost/text, danger (muted red), icon.
- Inputs: `--input` background, `--border-strong`, blue border + `--accent-glow` on focus, 6–9px radius, 16px font on phones.
- Motion: 150–250ms, opacity/border/4–8px moves; `prefers-reduced-motion` disables pulses.
- Provider brand colours stay only in `SourceIcon` glyphs and the neural graph's source tints.
