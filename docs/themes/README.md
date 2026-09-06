# PortOS Theme System

PortOS themes are design systems, not palette presets. A theme defines color, surface material, typography, radius, shadows, density, chart colors, motion, and route-level feel through a manifest in `client/src/themes/portosThemes.js`.

The current production UI remains available as `classic-midnight`. The re-imagined concepts are:

- `lumen-glass` - translucent glass control room.
- `black-ice-terminal` - dense cyberpunk terminal.
- `blueprint-ops` - systems-map drafting interface.
- `kestrel-neon` - CRT boot terminal with a neon grid floor.

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

Avoid hard-coded background colors for major containers. Hard-coded state colors are acceptable only when they are data colors and still pass contrast in all ten theme variants.

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

Only the tokens the active theme declares stay on `<html>`: `applyTheme` removes every custom property the previous theme set that the next one does not, so an optional token (an effect color, say) cannot leak across a switch.

## Effects

Full-screen effects are shared primitives, not per-theme CSS. A theme lists the ones it wants in its manifest and tunes them with `--port-fx-*` tokens; `useTheme` publishes the list as `data-port-theme-effects` on `<html>`, and `index.css` keys one block per effect on `html[data-port-theme-effects~="<name>"]`. Everything paints on the dedicated `<div class="port-fx-layer">` that `main.jsx` renders beside the app — never on `body` or `#root` pseudo-elements a theme might also style — so a theme's own backdrop rules (Lumen Glass Day's drifting mesh lives on `body::before/::after`) cannot collide with it.

| Effect | Where it paints | Tokens |
| --- | --- | --- |
| `scanlines` | CRT line overlay above the app (`.port-fx-layer::after`) | `--port-fx-scanline-color`, `--port-fx-scanline-period` |
| `vignette` | darkened viewport edges on that overlay | `--port-fx-vignette-color` |
| `sweep` | a phosphor band drifting down the screen (`.port-fx-sweep`, transform-animated so it never repaints the overlay) | `--port-fx-sweep-color`, `--port-fx-sweep-duration` |
| `grid-floor` | a perspective grid receding under the page (`.port-fx-layer::before`) | `--port-fx-grid-floor-x`, `--port-fx-grid-floor-y`, `--port-fx-grid-floor-opacity`, `--port-fx-grid-floor-duration` |
| `glitch` | periodic chromatic split on page titles (`h1`) | `--port-fx-glitch-period` |
| `aurora` | two slow, heavily blurred color blooms drifting behind the page (`.port-fx-aurora`) | `--port-fx-aurora-a`, `--port-fx-aurora-b`, `--port-fx-aurora-opacity`, `--port-fx-aurora-blur`, `--port-fx-aurora-duration` |
| `grain` | a static monochrome noise tile blended over the app (`.port-fx-grain`) | `--port-fx-grain-image`, `--port-fx-grain-size`, `--port-fx-grain-blend`, `--port-fx-grain-opacity` |

`scanlines` and `vignette` share the overlay and compose in a single background list, governed by `--port-fx-overlay-blend` and `--port-fx-overlay-opacity`; an effect the theme did not list resolves to a transparent layer. **A theme listing both has to pick a blend mode that serves both** — `screen` over a black vignette is a no-op, so Black ICE Terminal and Blueprint Ops run the overlay at `normal` and let straight alpha compositing lift the scanline instead. `aurora` and `grain` deliberately paint on their own children of the layer rather than joining that list, because each needs an opacity independent of it (Phosphor Paper runs a 6% grain under a 40% scanline overlay); `aurora` shares the below-content depth with `grid-floor`, so a theme picks one or the other, never both. Every effect animation is disabled under `prefers-reduced-motion`. `THEME_EFFECTS` in `portosThemes.js` is the registry — `npm run theme:check` fails on an unknown name, on a registered effect with no CSS block, and on a `--port-fx-*` token declared for an effect the theme does not list (it would silently paint nothing). A theme declares only the tokens where it diverges from the `:root` defaults. Adding an effect means: a name in `THEME_EFFECTS`, one `html[data-port-theme-effects~="<name>"]` block with its tokens defaulted in `:root`, its token prefix in `check-themes.js`, and a row here.

## Typography tokens

Headings read `--port-heading-tracking` and `--port-heading-glow` (h1–h3) plus `--port-title-tracking` and `--port-title-transform` (h1 only), defaulted to `0` / `none` in `:root`, so a theme sets its title treatment in the manifest instead of a selector block. Because the shared rule now sets `text-shadow` explicitly, a theme whose `body` carries a glow must restate it in `--port-heading-glow` for headings to keep it (Black ICE does) — Kestrel's uppercase, tracked, glowing titles are four tokens. The `glitch` effect rests on `--port-heading-glow`, so listing it never changes a theme's resting title look. The terminal and blueprint families set uppercase tracked titles the same way (a console banner and a drafting sheet label respectively); the sans families instead tighten `--port-heading-tracking` slightly, which is what large system-sans and Inter headings want.

Current assignments:

| Theme | Effects |
| --- | --- |
| Classic Midnight / Classic Noon | none — the baseline stays effect-free by design |
| Lumen Glass | `aurora`, `vignette` |
| Lumen Glass Day | `grain` (its drifting mesh stays on its own `body` pseudo-elements) |
| Black ICE Terminal | `scanlines`, `vignette`, `sweep`, `glitch` |
| Phosphor Paper | `scanlines`, `vignette`, `grain` |
| Blueprint Ops | `vignette` |
| Drafting Paper | `grain` |
| Kestrel Neon | `scanlines`, `vignette`, `sweep`, `grid-floor`, `glitch` |
| Kestrel Dawn | `scanlines`, `grid-floor` |

## Surface & control tokens

The same "tokens over per-theme selector blocks" pattern covers the shared card/focus/nav/code rules — with one twist: `border-color` and `box-shadow` are properties a component can also set for its own reasons (a card's "selected"/"error" border class, an accent button's interactive shadow), so a theme's override has to keep winning against those *without* also winning for every theme that never opted in. Where that matters, the token-driven rule stays scoped to the exact theme(s) that use it (`html:is([data-port-theme="…"], …) …`) rather than becoming unconditional — same values-not-selectors win, without a specificity regression.

`--port-card-surface-image` / `--port-card-surface-size` (a card's `background-image`/`background-size`, both a no-op by default) are safe to share unconditionally. `--port-card-border-color` / `--port-card-border-alpha` (a card's border, `rgb(var(--port-card-border-color) / var(--port-card-border-alpha))`) are read by a rule scoped to the themes that override them (Lumen Glass, Lumen Glass Day, Black ICE Terminal both modes, Blueprint Ops both modes, Kestrel both modes — Lumen Glass Day's wider `bg-port-card/NN` coverage beyond `.bg-port-card`/`/50` is its own separate selector, predating this rule).

`--port-focus-shadow` is the generic `button:focus-visible`/`a:focus-visible`/`[role="button"]`/`[tabindex="0"]` rule's default box-shadow and is never overridden per theme. The glass family's, the terminal family's, Blueprint Ops', and Kestrel Neon's stronger glow is a *different* token, `--port-focus-glow` (`none` by default, read only by their own theme-scoped `:is(input, textarea, select):focus, button:focus-visible, a:focus-visible` rule — every theme that selector matches must declare the token, or focus there resolves to `box-shadow: none`) — reusing `--port-focus-shadow` there would leak the glow onto `[role="button"]`/`[tabindex="0"]` elements the original per-theme rule never touched, and unscoping it entirely would lose to `.bg-port-accent`'s interactive shadow on an accent-colored button (a `.bg-port-accent` class carries higher specificity than the bare `button:focus-visible` rule).

`--port-nav-active-rule` (the active sidebar link's `border-left`) and `--port-nav-active-glow` (its `text-shadow`, defaulted to `inherit` rather than `none` since `text-shadow` is naturally inherited — Black ICE's body-wide glow reaches the active link through that) are shared unconditionally; `border-left` and `text-shadow` aren't properties any component sets on that element today. `--port-code-glow` (a `text-shadow` on `pre`/`code`/`textarea`/`input`, `none` by default) is likewise unconditional. `caret-color: rgb(var(--port-accent))` on that same selector is unconditional too — every theme gets an accent-colored text cursor, not just Kestrel.

## New Feature Checklist

Before merging UI work:

1. Test the feature in `classic-midnight`, `lumen-glass`, `black-ice-terminal`, `blueprint-ops`, and `kestrel-neon`.
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
- [Kestrel Neon](./kestrel-neon.md)
