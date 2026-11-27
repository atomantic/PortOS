# PortOS workspace design guide

Design for a returning operator who needs to identify the current state, act,
and see the result. Apply the guide incrementally alongside the
[client conventions](../client/src/AGENTS.md).

## 1. Navigation and page structure

- Use labeled, icon-prefixed desktop destinations and the compact mobile icon
  row. Preserve accessible names, selection, focus reveal and usable targets
  on both. Keep destinations accessible directly from navigation.
- Title the actual destination. Use one local row of task views and give
  related tasks clear names. Keep route-backed selection, Back/Forward,
  refresh, deep links and legacy redirects working.
- Use `server/lib/navManifest.js` for route and command metadata and
  `client/src/lib/navPresentation.js` for icons. Preserve optional-feature
  filtering, command palette and voice discovery.
- Put the title, current state, primary action and start of useful work in
  the first viewport. Surface blocking prerequisites and costs next to the
  action. Put occasional settings, selected evidence and diagnostic detail
  in a drawer, inspector or clearly labeled disclosure.

| Page family | Layout |
| --- | --- |
| Collection | Filters and aligned rows, with selected record detail |
| Workbench | Input next to its output or evidence |
| Operations | Compact health summary, actionable records and logs |
| Configuration | Named field groups with explicit save state |
| Analytics | Scope, comparable results and methodology on demand |
| Document or canvas | Bounded reading column or full-bleed editor |

## 2. Layout and visual hierarchy

Use existing theme tokens, one clear page title, readable text and aligned
values. Keep prose to roughly 60–75 characters per line. Begin with one
column in narrow content areas and add a second column when both the main
task and its evidence fit. Use one vertical scroll owner for an ordinary
page and keep focus clear of sticky headers, save bars and keyboards.

Use 14px for body text and table values, with editable fields at least 16px
on touch layouts. Aim for a 44px effective touch target. Communicate
status with text or icons as well as color. Align numeric comparisons,
label units and distinguish missing measurements from zero. Provide the full
identifier for shortened labels through an accessible detail or copy action.

## 3. Actions, forms and results

- Reuse `PageHeader`, `TabPills`, `Drawer`, `FormField`, `Banner`,
  `OverflowMenu` and `PageSkeleton`. Give each task one primary action and
  preserve visible frequent secondary actions. Use existing confirmations
  for destructive actions.
- Preserve autosave and explicit-save behavior. Show save progress or
  failure near the fields, keep drafts on view switches, surface validation
  on the affected tab and gate dependent runs on saved state.
- Show the provider, model, operation scope and relevant cost or download
  before model work. Navigation and reading results never start provider work.
  Keep batch scope and concurrency or spend gates visible.
- Acknowledge actions immediately with accurate queued, running or terminal
  states. Keep progress and cancellation reachable across local views.
- Distinguish loading, empty, unavailable, partial and stale states. On a
  failed refresh, retain prior results, mark them stale and offer a retry
  at the failed region.
- Compare like measurements. In performance views label characters/s and
  tokens/s distinctly and expose context length, runtime, timing basis and
  measurement age.

## 4. Acceptance and evaluation

Check keyboard-only flows, visible focus, labels, status announcements,
light/dark/decorative themes, 200% text zoom and 400% page zoom. Exercise
ready, empty, loading, failure, stale, running, cancelled and complete
states with synthetic records. Verify saved drafts, deep links and route
transitions, and confirm navigation causes no provider call.

Test useful work on the first viewport and check viewport and embedded widths
as described below. Use rendered interaction and route-boundary tests for
behavior and browser checks for geometry. See
[WCAG 2.2](https://www.w3.org/TR/WCAG22/) and
[W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).

## List deletion and reading position

Keep the populated list and scroll container mounted. After server
confirmation, collapse the row with `CollapsibleListItem` and remove it
locally on exit. Preserve filters, paging and unrelated selection. Refresh
counts separately. Honor reduced motion, transfer focus without scrolling,
prevent duplicate requests and leave a failed deletion visible for retry.
See Brain's Memory tab for the pattern.

## Realtime updates, not polling

Apply the mutation response immediately. Use `useSocketSubscription` or the
media job hooks for updates from other actors. If an event is missing, emit it
from the service and declare it in `server/lib/socketEventContracts.js`.
Reconcile once on reconnect or when the tab becomes visible. Stream job
progress through Socket.IO or SSE. Avoid recurring status reads and fixed-delay
refetches after mutations.

Timer-based reads are reserved for a visible hardware telemetry inspector,
an external system with no callback, and PortOS restarting itself
(`usePortosRestartWatch`). Use visibility-gated, single-flight `useAutoRefetch`
with a call-site justification and stop when the consumer closes.
`client/lint-no-view-interval.grit` bans raw `setInterval` in views.

## Large collections and incremental loading

- Fetch for the active route or tab only, with a bounded server page
  (typically 25–50 records). Send row projections and load details on
  demand, fetching full values before editing. Use thumbnails for media.
- Use stable cursors for changing histories, deduplicate by ID and apply
  filters, order and search before pagination. Label local search and
  counts by scope. Fetch a deep-linked record directly.
- Reuse `usePagedCollection` and `InfiniteScrollFooter`. Provide an accessible
  Load more control and announce loading and completion. On failure, retain
  loaded rows, stop automatic loading and offer explicit retry.
- Cancel obsolete requests and reset the cursor on query changes. Preserve
  identity, updates, scroll and selection when events arrive. Measure
  rendered row count and use bounded windows or virtualization when needed.

## Config drawers

Use the shared `Drawer.jsx`. Choose a size that fits the fields and keep
mobile full-width. Use the built-in `TabPills` for large tabbed forms and
named groups for forms that fit in one view.

Keep all mutable values in the parent because tab bodies remount. Validate
all fields on Save and switch to the failing tab. Use `useDrawerTab` for
deep linking with a safe default. Set `closeOnEsc={false}` and
`closeOnBackdrop={false}` for long-lived forms. Portal overlays to `<body>`
so styled ancestors cannot become fixed-position containing blocks.

## Narrow monitors and embedded containers

Measure available content width. A desktop sidebar, drawer or widget can
leave a 240–480px panel. Use named container queries on descendants,
shrinkable grid and flex children, wrapping actions and bounded inputs.
Stack side rails until both columns and the gap fit. Wrap long values or
provide accessible full-value text. Intentional table and code scrolling
belongs in a local, keyboard-accessible region. Fix overflow at the child layout
so every control remains reachable.

Check 320, 390, 768, 1024, 1280 and 1440px viewports, with navigation expanded
and collapsed. Check widgets at 240, 320 and 480px on a desktop viewport.
Measure child rectangles as well as scroll dimensions to detect clipping.
Record the route, available width, state and observed result.
