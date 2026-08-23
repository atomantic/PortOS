# PortOS Theme System

PortOS themes are design systems, not palette presets. A theme defines color, surface material, typography, radius, shadows, density, chart colors, motion, and route-level feel through a manifest in `client/src/themes/portosThemes.js`.

The current production UI remains available as `classic-midnight`. The three re-imagined concepts are:

- `lumen-glass` - translucent glass control room.
- `black-ice-terminal` - dense cyberpunk terminal.
- `blueprint-ops` - systems-map drafting interface.

## Integration Contract

New UI should use semantic PortOS tokens wherever possible:

- Colors: `bg-port-bg`, `bg-port-card`, `border-port-border`, and the semantic foreground tokens `text-port-accent`, `text-port-accent-2`, `text-port-success`, `text-port-warning`, and `text-port-error`.
- Text: use `text-port-text`, `text-port-text-muted`, and `text-port-text-subtle` for primary, supporting, and tertiary copy. Their CSS variables are `--port-text`, `--port-text-muted`, and `--port-text-subtle`.
- Filled-control ink: pair each semantic fill with its matching `text-port-on-*` token (`text-port-on-accent`, `text-port-on-accent-2`, `text-port-on-success`, `text-port-on-warning`, or `text-port-on-error`). These are intentionally separate from the surface-text tokens.
- Surfaces: prefer `bg-port-card border border-port-border rounded-lg` for panels and `bg-port-bg border border-port-border rounded-lg` for inset controls.
- Controls: inputs, textareas, and selects should use `bg-port-bg border border-port-border`; theme CSS supplies the material, radius, and focus behavior.
- Buttons: use `bg-port-accent text-port-on-accent` for filled primary actions, `bg-port-border text-port-text-muted hover:text-port-text` for neutral actions, and `bg-port-*/20 text-port-*` for tonal status actions. Keep tonal fills at 30% or below when using surface-semantic ink; 40% and above is treated as a filled state and must pair with `text-port-on-*`. Legacy `text-white`, `text-gray-*`, and solid semantic Tailwind hue utilities remain supported through the shared compatibility layer, but new code should use the semantic tokens directly.
- Icons: use the existing lucide icon style and let `text-port-accent` carry theme identity.
- Charts: use `rgb(var(--port-chart-1))` through `rgb(var(--port-chart-4))` for series and `rgb(var(--port-chart-grid) / 0.34)` for grid lines.
- Terminal/log output: use `var(--port-terminal-bg)` and `var(--port-terminal-text)` when authoring custom CSS.

Avoid hard-coded background colors for major containers. Hard-coded state colors are acceptable only when they are data colors and still pass contrast in all eight theme variants.

The shared CSS contract keeps surface text between **4.5:1 and 15.5:1** against both the page and minimum card surfaces. The lower bound protects readability; the upper bound avoids glare from unnecessary near-white/near-black pairings. Solid legacy neutral backgrounds (`bg-gray-800` through `bg-gray-500` and their zinc/neutral/slate equivalents) are aliases of the theme surface tokens. Fixed media, scrims, terminals, and canvas overlays are the documented exceptions and must keep their own explicit overlay contract.

## Surface Elevation

Three levels, and every theme must render all three distinguishably in both day and night mode:

| Level | Class | What it is |
| --- | --- | --- |
| Page | `bg-port-bg` | The backdrop everything sits on. |
| Card | `bg-port-card` (any opacity) | A content panel raised off the page. |
| Well | `bg-port-bg` **inside a card** | An inset row, list item, or control — sunken back to the page color. |

Two rules keep this readable across the palettes:

- **`--port-card-min-alpha`** (per theme, in `portosThemes.js`) floors the fill of a card written at reduced opacity. `bg-port-card/40` used to render at 40% of the card color composited over the page — on themes whose card and page differ by design (every day theme), that dissolved the card into the page and left a border floating around nothing. State variants (`hover:bg-port-card/60`) are deliberately **not** floored: a hover that lands on the resting fill is not feedback. Translucent themes set a lower floor so glass stays glass.
- **Card / page separation ≥ 1.12:1**, measured on that floored fill. Not a WCAG number (WCAG says nothing about surface separation) — it is the empirical floor at which a filled panel reads as raised on these palettes. `portosThemes.test.js` asserts it for every theme, along with body/muted text still clearing AA on the resulting fill, so a new theme cannot ship invisible cards.

For a nested panel, prefer `bg-port-bg` at full strength over `bg-port-bg/40`: at 40% it composites most of the way back to the card fill, and a stack of them runs together as one block.

## Theme Runtime

`useTheme` applies the active theme to `<html>`:

- `data-port-theme`
- `data-port-theme-family`
- `data-port-theme-density`
- CSS variables from the theme manifest

The global CSS layer in `client/src/index.css` maps those variables onto existing PortOS utility classes. That keeps older pages working while new components can move toward semantic component primitives over time.

## New Feature Checklist

Before merging UI work:

1. Test the feature in `classic-midnight`, `lumen-glass`, `black-ice-terminal`, and `blueprint-ops`.
2. Check desktop and mobile widths.
3. Verify focus rings, active tabs, hover states, forms, modals, toasts, and empty states.
4. Check tables, charts, terminal/log blocks, and scroll containers when present.
5. Run `npm run theme:check`.
6. Run `npm run build`.

## Documents

- [Classic Midnight](./classic-midnight.md)
- [Lumen Glass](./lumen-glass.md)
- [Black ICE Terminal](./black-ice-terminal.md)
- [Blueprint Ops](./blueprint-ops.md)
