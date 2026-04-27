# PortOS Theme System

PortOS themes are design systems, not palette presets. A theme defines color, surface material, typography, radius, shadows, density, chart colors, motion, and route-level feel through a manifest in `client/src/themes/portosThemes.js`.

The current production UI remains available as `classic-midnight`. The three re-imagined concepts are:

- `lumen-glass` - translucent glass control room.
- `black-ice-terminal` - dense cyberpunk terminal.
- `blueprint-ops` - systems-map drafting interface.

## Integration Contract

New UI should use semantic PortOS tokens wherever possible:

- Colors: `bg-port-bg`, `bg-port-card`, `border-port-border`, `text-port-accent`, `text-port-success`, `text-port-warning`, `text-port-error`.
- Text: default body text inherits `rgb(var(--port-text))`; secondary text should use `text-gray-400` or `rgb(var(--port-text-muted))` when authoring CSS.
- Surfaces: prefer `bg-port-card border border-port-border rounded-lg` for panels and `bg-port-bg border border-port-border rounded-lg` for inset controls.
- Controls: inputs, textareas, and selects should use `bg-port-bg border border-port-border`; theme CSS supplies the material, radius, and focus behavior.
- Buttons: use `bg-port-accent text-white` for filled primary actions, `bg-port-border text-gray-400 hover:text-white` for neutral actions, and `bg-port-*/20 text-port-*` for tonal status actions. The runtime maps those legacy utility pairs to theme-safe control fills and foreground colors.
- Icons: use the existing lucide icon style and let `text-port-accent` carry theme identity.
- Charts: use `rgb(var(--port-chart-1))` through `rgb(var(--port-chart-4))` for series and `rgb(var(--port-chart-grid) / 0.34)` for grid lines.
- Terminal/log output: use `var(--port-terminal-bg)` and `var(--port-terminal-text)` when authoring custom CSS.

Avoid hard-coded background colors for major containers. Hard-coded state colors are acceptable only when they are data colors and still pass contrast in all themes.

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
