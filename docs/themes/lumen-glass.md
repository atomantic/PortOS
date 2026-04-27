# Lumen Glass

## Intent

Lumen Glass turns PortOS into a translucent personal command deck. It should feel layered, luminous, and calm while keeping the app practical for repeated daily use.

## Integration Rules

- Let surfaces breathe. Prefer fewer nested cards and use page sections or panels directly.
- Use `bg-port-card border border-port-border` for glass panes. The theme supplies transparency, blur, border alpha, and depth.
- Avoid opaque hard-coded dark panels unless the content is media, code, or terminal output.
- Avoid extra decorative blobs or unrelated gradients. The theme background already carries the visual atmosphere.
- Keep icon buttons compact and use `text-port-accent` for tool affordances.

## Component Notes

- Cards and modals should keep their borders visible so transparent surfaces remain legible.
- Inputs should use standard PortOS input classes; the theme converts them to translucent controls.
- Filled buttons use dark foreground tokens on bright cyan surfaces. Do not override them with muted gray text.
- Tables should keep row separators because glass depth alone is not enough for dense data.
- Charts should use the theme chart variables rather than fixed blue-only series.
- Toasts and command palette overlays should use elevated shadows and backdrop blur.

## Validation

Check text contrast over every transparent surface. Pay special attention to data grids, empty states, and nested panels where background content can show through.
