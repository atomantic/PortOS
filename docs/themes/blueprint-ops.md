# Blueprint Ops

## Intent

Blueprint Ops presents PortOS as a systems map: organized, annotated, technical, and calm. It should feel like a drafting table for apps, goals, agents, and personal telemetry.

## Integration Rules

- Favor structured panels, thin separators, compact metadata rows, and clear hierarchy.
- Use the grid background as context, not decoration. Avoid adding extra grid patterns inside custom components unless the theme token supplies them.
- Prefer precise labels and concise controls.
- Use accent blue for selection, emerald for success, amber for attention, and red only for destructive or failed states.
- Keep charts and diagrams legible with theme chart tokens.
- Night lists the shared `vignette` effect (a drafting table lit from above); Drafting Paper (day) lists `grain` for vellum tooth. Neither runs an animated effect, so both stay calm at rest.

## Component Notes

- Page headings receive a left rule in this theme. Avoid wrapping headings in deeply nested cards.
- `h1` renders uppercase with wide tracking — a drafting-sheet label, paired with that left rule. Keep page titles short.
- Card borders take an accent tint (`--port-card-border-color`) over the drafting grid, so a panel reads as a drawn frame rather than a neutral box. A component's own semantic border class (`border-port-error`, a "selected" state) still wins.
- Cards should remain low-shadow and border-led.
- Neutral controls should stay slate-filled with light text; reserve filled blue for primary actions.
- Status badges should keep both text and color.
- Forms should be compact but not cramped.
- Graph, goals, calendar, insights, and dashboard views are the best-fit surfaces.

## Validation

Check horizontal overflow on mobile because compact blueprint layouts can accumulate metadata. Verify page headings, tabs, and card titles do not collide with the left-rule treatment.
