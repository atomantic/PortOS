# Dashboard Widgets & Layouts (`client/src/components/dashboard/`)

See [layout maintenance](../../../../docs/INSTRUCTION_RULE_DETAIL.md#dashboard-layout-maintenance) for implementation details.

Register widgets in `widgetRegistry.jsx`. The dashboard renders the active layout. Built-ins seed on first read, cannot be deleted and get the same dynamic palette commands as custom layouts.

**Grid model.** Store 12-column placement with `{ id, x, w, order, h?, fixedH? }`. Pack by `order`, or synthesize an empty grid from widget defaults. Below 640px container width sort by `order`, then `x`. Keep legacy `y` reads. New seed migrations write `order`.

**Height.** Measure content with `ResizeObserver` and refresh fallback `h` on drag commit. Explicit height pins and clips with `fixedH`. Provide the edit-mode reset handle.

**Arrange mode (desktop).** Each cell gets move (top-right) and resize (bottom-right) handles. A move snaps to columns and re-inserts at the rank its drop position implies (`rankAtPixel` → `insertAtOrder`), renumbering `order` densely; Save persists to the layout's `grid`.

- Share placement between pointer and keyboard. Enter/Space lifts or drops, arrows step and Escape restores. Horizontal keyboard steps keep order. Announce steps and expose grabbed state.
- **A keyboard grab is modal**: anything that ends Arrange mode under it (Save/Cancel, a rotation across the breakpoint) must cancel it, since unmounting a focused handle fires no blur. One effect watching `editable`/`isMobile` owns that.

**Mobile reordering.** Free-form move/resize is desktop-only; on mobile, edit mode shows one reorder handle backed by `client/src/lib/dnd/` (`PointerSensor` + `KeyboardSensor` + `verticalListSortingStrategy`, as in `cos/tabs/TasksTab.jsx`). Never hand-roll a pointer gesture for it. Use `dndTransformToCss` from `client/src/lib/dndTransform.js`, never `@dnd-kit/utilities`, and keep `touch-action: none` on the handle. On drop, `onDragEnd` re-flows the grid through `reflowToOrder` (keeping each `w`/`h`), which re-packs the desktop layout into row flow; the edit-mode hint says so.

**The mobile/desktop seam has one source of truth.** `DashboardGrid` measures its own container (`useContainerWidth`), which is narrower than the viewport, so a Tailwind `sm:` breakpoint disagrees with it. Anything outside the grid that needs the live mode reads it from `onLayoutModeChange`.

**Widgets lay out by container query, never viewport breakpoint.** Put `@container` on the component's own root (not the grid cell, since the same component renders in drawers and full pages) and use `@sm:`/`@md:`/`@lg:`. Viewport variants are only for device affordances such as hover-vs-touch, and need an allowlist entry: `client/src/test/guards/ui/dashboardWidgetContainerConventions.test.js` fails on any bare `sm:`/`md:`/`lg:`/`xl:`/`2xl:` in a module `widgetRegistry.jsx` lazy-imports. `@container` makes the element a containing block for `position: fixed`, so a widget's fixed overlay is portaled to `<body>` (`Modal`'s `usePortal`).

**Order.** The grid owns position. Only reorder when the layout editor explicitly reports a reorder against its unmoved baseline, since legacy widget arrays can disagree with grid order.

**Adding a widget:**
1. Add an entry to `WIDGETS` in `widgetRegistry.jsx` with a stable kebab-case `id` (stored in layouts) and a rough `defaultH`.
2. Read dashboard data (apps/health) from the `dashboardState` prop rather than fetching it again, and list the streams it or its `gate` reads in `needs`; only widgets that declare `needs` get the prop, and the page fetches only the streams the active layout needs.
3. Add `gate: (state) => boolean` if it only makes sense sometimes.
4. Add its id to the built-in `default` layout in `server/services/dashboardLayouts.js` if it should appear out of the box.

**First paint comes from a local copy (`dashboardBoot.js`).** The last server-confirmed layouts response is cached in `localStorage`, so a reload paints the grid and starts widget chunks before `GET /api/dashboard/layouts` returns, while data reads wait for a known layout so they don't queue ahead of it. The cache is display-only: the picker, Arrange and the editor stay hidden until the server copy lands, and it is never written back.
