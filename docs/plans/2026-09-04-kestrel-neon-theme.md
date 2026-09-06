# Kestrel Neon theme, shared theme effects, and the Core Assembly avatar

## Context

A single-file "boot terminal" concept (cyan `#00f0ff` and magenta `#ff2bd6` on
`#05060a`; every glow a text-shadow, every scanline a gradient; a perspective
grid floor; a rotating wireframe icosahedron in a telemetry panel) was the
brief for a new PortOS theme with day and night variants. Its icosahedron
became a new Chief of Staff avatar.

Two things about the existing theme system got in the way and were fixed as
part of the work rather than worked around:

- Every full-screen effect (Black ICE's scanlines, Lumen Glass Day's drift) was
  a bespoke `html[data-port-theme="<id>"]` block, so a day/night pair
  duplicated its effect CSS and a new theme could not reuse an effect without
  copying it.
- `applyTheme` only ever *set* custom properties on `<html>`. Because every
  theme declared the same token set that never showed, but the moment a theme
  declares an optional token, switching away leaves it inline on `<html>` and
  it leaks into the next theme.

## Design

**Theme family `kestrel`** (`client/src/themes/portosThemes.js`):
`kestrel-neon` (night) and `kestrel-neon-day` ("Kestrel Dawn"). IBM Plex Mono
for UI, display, and code — the concept is a terminal. Palettes graded by the
existing contrast contract (`portosThemes.test.js`, `chipContrast.test.js`,
`npm run theme:check`). Day darkens magenta to `#b5178f` and swaps cyan for teal
`#0e7c8c` so the two-ink identity survives on white.

**Shared effects layer** (`client/src/index.css`, "Theme effects layer"):
a theme lists effects in its manifest (`effects: [...]`, registry
`THEME_EFFECTS`); `useTheme` publishes them as `data-port-theme-effects` on
`<html>`; each effect is one block keyed on
`html[data-port-theme-effects~="<name>"]` and parameterized by `--port-fx-*`
tokens defaulted in `:root`. Everything paints on a dedicated
`<div class="port-fx-layer">` rendered by `main.jsx`, so a theme's own
`body::before/::after` rules (Lumen Glass Day's drift) can never collide with
it: `::before` is the below-content slot (`grid-floor`), `::after` the static
overlay (`scanlines` + `vignette` composed in one background list, unlisted
effects transparent), and a `.port-fx-sweep` child is the moving band. The
sweep and the floor animate `transform` only, so they stay on the compositor
instead of repainting a blended full-screen layer every frame. `glitch`
animates `h1` and rests on the new `--port-heading-glow` token (with
`--port-heading-tracking`, `--port-title-tracking`, `--port-title-transform`,
heading treatment is now a manifest concern, not a selector block). Every
animation is off under `prefers-reduced-motion`. Black ICE Terminal's
scanlines moved onto the shared layer with identical values, so it renders as
before.

**`applyTheme` clears stale tokens**: it walks the inline `--port-*`
properties on `<html>` and removes any the next theme does not declare (`useTheme.test.jsx` pins both the
effects attribute and the clearing).

**Core Assembly avatar** (`client/src/components/cos/CoreCoSAvatar.jsx`,
style id `core`): a plain 2D canvas, so it needs no WebGL and skips
`CoSCanvasGuard`. Geometry and the frame renderer are pure
(`client/src/lib/wireframeCore.js`). Edges take the agent-state color (the
intentional 7-way `AGENT_STATES` enum); rings and vertices follow
`--port-accent-2`, re-resolved on theme switch through `useCanvasRollPalette`
(which now takes the resolver as an argument) and sized through
`useCanvasDprSize` (which now follows the container height); reduced motion
comes from the new shared `usePrefersReducedMotion` hook, which BrainGraph
also adopted. Spin and glow
scale per state, `speaking` bursts both, drag rotates, and reduced motion holds
one static frame. It is theme-independent: pick it under any theme.

## Verification

- `npm run theme:check`; `portosThemes`, `chipContrast`, `useTheme`,
  `wireframeCore`, `CoreCoSAvatar`, `ConfigTab`, `ChiefOfStaff`, and the server
  `cosStatusRoutesAvatar` suites; full client and server suites.
- Built the client and screenshotted a static preview of both variants, Black
  ICE, and Classic Midnight against the built stylesheet to confirm the effects
  attribute, the shared overlay, the grid floor geometry, and the avatar frame.
