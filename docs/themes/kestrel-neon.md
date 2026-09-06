# Kestrel Neon

## Intent

Kestrel Neon turns PortOS into a CRT boot terminal: a scanlined void, a perspective grid floor receding under the page, cyan wireframes, and magenta panel labels. It borrows its palette and effects from a single-file "boot terminal" concept (cyan `#00f0ff` and magenta `#ff2bd6` on `#05060a`, every glow a text-shadow, every scanline a gradient) and reads as the machine-room view of an agent runtime — logs, orchestration, telemetry.

The day variant, **Kestrel Dawn**, keeps the geometry and the two-ink identity but prints it in daylight: holographic white panels on a pale lavender page, teal ink where night had cyan, magenta darkened for contrast, the grid floor faded to a watermark, no sweep or glitch.

Both variants use IBM Plex Mono for UI, display, and code — the concept is a terminal, so the whole interface is monospaced.

## Integration Rules

- Cyan (`--port-accent`) is the primary voice: selection, focus, links, live values. Magenta (`--port-accent-2`) is the secondary voice: panel borders, labels, active-nav rules, AI-generated or recommendation content. Do not swap the two inside a component.
- Amber is attention, green is healthy, rose is failure — the reference terminal's `[WARN]` / `[ OK ]` / error vocabulary. Keep status badges text-labelled; the neon hues are close in brightness at a glance.
- Surfaces are near-black with a magenta hairline; do not add your own borders in hard-coded colors. `bg-port-card border border-port-border` picks up the theme's top-edge cyan wash automatically.
- Corners are square (`--port-radius-*` near zero). Do not round custom containers by hand.
- The effects are the shared `scanlines`, `vignette`, `sweep`, `grid-floor`, and `glitch` primitives (see the Effects section of the themes README), tuned through the `--port-fx-*` tokens in the manifest. The scanline and vignette overlay sits at `z-index: 9998` with `pointer-events: none` and `mix-blend-mode: multiply`; fixed media (video, canvases) will show faint lines through it. That is the theme. Do not raise a component above it to escape.
- Text carries a faint glow. Avoid thin (300-weight) type and avoid text under ~11px in custom components — the glow softens small glyphs.

## Component Notes

- `h1` renders uppercase with wide tracking and a periodic chromatic glitch (night only; disabled under `prefers-reduced-motion`). Keep page titles short — they are shouted.
- The active sidebar item gets a magenta left rule and a cyan text glow.
- Inputs and code blocks use a cyan caret and a soft cyan text glow; the focus ring is a one-pixel cyan line plus an 18px glow rather than a thick halo.
- Charts: series 1 cyan, 2 magenta, 3 amber, 4 green; grid lines cyan at 34%.
- The **Core Assembly** CoS avatar (`avatarStyle: 'core'`) is this theme's telemetry widget — a rotating, depth-shaded wireframe icosahedron on a 2D canvas whose edges take the agent-state color and whose rings and vertices follow `--port-accent-2`. It is theme-independent (pick it under any theme) and needs no WebGL.
- Day mode: the grid floor is a watermark and the scanlines are a 5% teal multiply, so photographs and thumbnails stay clean. No sweep, no glitch.

## Validation

- Check the full-page overlay against modals, toasts, and drawers: they must stay legible through the scanlines (contrast tokens are graded against the page and card fills, not the overlay).
- Verify `h1` uppercase does not overflow narrow headers on mobile; long titles wrap rather than truncate.
- Confirm the grid floor sits behind fixed-bottom bars and does not paint over the sidebar on small widths.
- Test the CoS page with `core` selected, in both day and night, and with `prefers-reduced-motion` on (the avatar must render one static frame).
- Run `npm run theme:check` and the `portosThemes` / `chipContrast` suites; the day variant's magenta and teal inks are tuned to the 30% tonal-fill contrast floor and will fail if lightened.
