# Blueprint Ops

## Intent

Blueprint Ops presents PortOS as a systems map: organized, annotated, technical, and calm. It should feel like a drafting table for apps, goals, agents, and personal telemetry.

## Integration Rules

- Favor structured panels, thin separators, compact metadata rows, and clear hierarchy.
- Use the grid background as context, not decoration. Avoid adding extra grid patterns inside custom components unless the theme token supplies them.
- Prefer precise labels and concise controls.
- Use accent blue for selection, emerald for success, amber for attention, and red only for destructive or failed states.
- Keep charts and diagrams legible with theme chart tokens.

## Component Notes

- Page headings receive a left rule in this theme. Avoid wrapping headings in deeply nested cards.
- Cards should remain low-shadow and border-led.
- Neutral controls should stay slate-filled with light text; reserve filled blue for primary actions.
- Status badges should keep both text and color.
- Forms should be compact but not cramped.
- Graph, goals, calendar, insights, and dashboard views are the best-fit surfaces.

## Validation

Check horizontal overflow on mobile because compact blueprint layouts can accumulate metadata. Verify page headings, tabs, and card titles do not collide with the left-rule treatment.
