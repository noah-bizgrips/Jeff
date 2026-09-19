# Mobile conventions

Jeff is used as an installed iOS home-screen web app (PWA) as well as on desktop. The desktop
design is the source of truth; phone layouts adapt it without redesigning it.

## Breakpoints (app/globals.css)

| Query | Meaning | What changes |
| --- | --- | --- |
| `max-width: 1000px` | tablets and phones | Ask Jeff becomes a full-height sheet with a close button; floating "Ask Jeff" button appears; workspace body stacks. |
| `max-width: 720px` | phones | Sidebar becomes a drawer with a tap-to-close scrim; topbar is sticky and safe-area padded; every grid is single column; filter tabs scroll horizontally; modals are bottom sheets with sticky header/actions; all form controls are 16px (no iOS focus zoom) and ≥44px tall. |
| `max-width: 380px` | small phones | Action buttons go full width. |
| `display-mode: standalone` | installed PWA | Extra top padding under the iOS status bar. |
| `hover: none` | touch devices | Hover transforms disabled (no sticky hover on iOS). |

The final "Mobile pass" block at the end of `globals.css` is intentionally last so it overrides the
prototype-era rules above it. Add new phone rules there.

## Safe areas

`app/layout.tsx` sets `viewportFit: "cover"`. Use the CSS variables `--safe-top`,
`--safe-bottom`, `--safe-left`, `--safe-right` (wrapping `env(safe-area-inset-*)`) only on fixed or
sticky chrome: topbar, sidebar, agent panel composer, floating button, toasts, modal action rows.
Never pad regular page content with them (it would double up).

## Overlays

`components/jeff/store.tsx` mirrors `sidebarOpen` / `agentOpen` onto `<body>` as `sidebar-open` /
`agent-open` so CSS can react without `:has()`. Both drawers close automatically on route change and
on Escape; the sidebar also closes when the scrim (`.drawer-scrim`) is tapped.

## Modals

`<dialog>` is a flex column; `#modalContent` scrolls. On phones the dialog is a bottom sheet:
`.modal-header` sticks to the top, `.modal-actions` sticks to the bottom (with safe-area padding),
and action buttons are 44px two-up (one-up under 380px). Any modal built from `ModalHeader` +
`.modal-body` + `.modal-actions` gets this for free.

## Grids and inline styles

Do not set `gridTemplateColumns` inline — it beats the media queries. Use `.form-grid`
(one column on phones) or `.form-grid-2` (two columns, collapsing to one). Flex rows of buttons
should set `flexWrap: "wrap"`.

## Filter tabs

`.filter-tabs` scrolls horizontally on phones (hidden scrollbar, scroll-snap). Inside
`.view-toolbar` it keeps the container's padding.

## Text

Long identifiers (URLs, hashes, ids) wrap via `overflow-wrap: anywhere` on content containers.
Only `.diff-preview`, `.code-hint` and `pre` may scroll horizontally.

## Checking changes

There is no device farm in CI. Before merging UI changes, open the page in Safari's Responsive
Design Mode at 390×844 and in the installed PWA on an iPhone, and check: no horizontal scroll,
the bottom of every modal is reachable, the composer stays above the keyboard, and the floating
Ask Jeff button does not cover the last action on the page.
