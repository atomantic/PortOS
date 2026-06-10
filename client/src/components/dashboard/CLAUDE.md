# Dashboard Widgets & Layouts (`client/src/components/dashboard/`)

Dashboard widgets are registered in `widgetRegistry.jsx` — each entry has `{ id, label, Component, width, defaultH?, gate? }`. The Dashboard page renders the active layout's widget list from this registry; named layouts persist in `data/dashboard-layouts.json` and are managed via `GET/PUT/DELETE /api/dashboard/layouts`. Built-in layouts (`default`, `focus`, `morning-review`, `ops`) are seeded on first read and cannot be deleted.

**Grid positions:** layouts also carry a `grid: [{ id, x, y, w, h }]` array — free-form positions on a 12-column grid (rows ~80px each). When `grid` is empty (legacy/unmigrated layouts) the renderer auto-flows widgets using `synthesizeGrid` based on each widget's `width` keyword and `defaultH`. The "Arrange" button on the Dashboard enters edit mode where every widget exposes a move (top-right) and resize (bottom-right) handle; drag is snap-to-grid with collision-resolve via `placeAndCompact` (pins the moved item, slots others into the smallest non-colliding y). Save persists to the active layout's `grid`. The grid renderer collapses to a single-column stack below 640px viewport width — drag/resize is desktop-only.

**When adding a new dashboard widget:**
1. Add a `{ id, label, Component, width, defaultH?, gate? }` entry to `WIDGETS` in `widgetRegistry.jsx`. Use a stable `id` (kebab-case) — it's the contract stored in layouts. Pick `defaultH` based on the widget's natural content height (default `4`); this controls the size when it's first auto-placed into a grid.
2. If the widget needs dashboard data (apps/usage/health), read it from the `dashboardState` prop — do NOT issue a duplicate fetch from inside the widget.
3. If the widget only makes sense in some cases (e.g. only when apps exist), add a `gate: (state) => boolean` predicate.
4. Add the widget id to the built-in `default` layout in `server/services/dashboardLayouts.js` if it should appear out of the box.
5. Users can toggle widgets on/off per layout via the Dashboard's layout picker → Edit, and arrange/resize them via the "Arrange" button.

Switching layouts is also wired into the `⌘K` palette — it synthesizes a `Dashboard: <name>` command per layout at palette-open time, so any layout the user creates is instantly keyboard-reachable without further registration.
