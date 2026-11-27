# Client conventions (`client/src/`)

Root instructions also apply.

## UI conventions

- **Actions look like buttons**: a border, padding and hover/focus treatment; plain text links are for navigation and references. Keep controls usable on touch.
- **Fix missing prerequisites in place.** Name the missing tool or setting beside the blocked action. Link to the exact setup or record and offer retry after external setup.
- **Timestamps display in browser-local time** via the shared formatters in `utils/formatters.js`; never render an ISO/UTC string. ISO stays for transport and persistence; explicit schedule timezones and date-keyed reporting keep their semantics.
- **Admin workspace design**: new or redesigned admin pages follow [the workspace design guide](../../docs/UX_DESIGN_GUIDE.md), incrementally; it does not authorize unrelated behavior changes or a global CSS rewrite.
- Use inline confirmations and toasts in place of browser dialogs.
- Pair form labels and input IDs.
- **Narrow containers on desktop** follow the [narrow-container contract](../../docs/UX_DESIGN_GUIDE.md#narrow-monitors-and-embedded-containers): container queries, shrinkable grid/flex children, wrapping actions, long-string handling. Verify child rectangles as well as scroll dimensions; hiding overflow is not a fix.
- Add a breakpoint for grids wider than three columns.
- Shared primitives with built-in `inline-flex` must yield to caller display classes. Follow `Pill`'s `OWN_DISPLAY`.
- Cap popovers of 256px or wider with `max-w-[calc(100vw-1rem)]`.
- Keep hover-revealed actions visible on touch.
- Give icon-only buttons a 44px hit area, using coarse-pointer variants in dense rows.
- Set `touch-none` on drag handles. Use long-press when the drag source must keep native panning.
- **Size form fields for their content.** Share rows when there is room and stack when narrow.
- Use `TabPills mobileCompact` for sub-nav that outgrows phones.
- **Above the fold**: actionable content stays visible without scrolling.
- **No hardcoded localhost**: build URLs from `window.location.hostname` (used over Tailscale).
- Use `.port-media-overlay` variants for chrome over media in both themes.
- Follow alphabetical order in sidebar sections and their children after the pinned top group.
- Claim Space with `useKeyCapture` and centralize global-key guards in `shouldIgnoreGlobalKey`. Spread `noPointerFocusSurfaceProps` on key-owning surfaces.
- **Never `autoFocus` a control revealed by key-submit.** Keep focus on the submitting control and ignore repeated Enter events.
- Use `lib/safeStorage.js` for Web Storage.
- **Push, don't poll.** Fetch once, then update from Socket.IO events (`useSocketSubscription`, the media-job hooks) and apply your own mutation's response immediately. Declare missing server events in `server/lib/socketEventContracts.js` ([exceptions](../../docs/UX_DESIGN_GUIDE.md#realtime-updates-not-polling)).
- Use `useAutoRefetch` with `enabled` for sanctioned polling. Use `immediate: false` if another effect owns the first fetch. Document local-only timers.
- Keep timer and `fetch` names free of local bindings.
- Discard stale async effect responses on identity change ([pattern](../../.claude/skills/portos-socket-ui/SKILL.md)).
- Use `formatCount` / `formatUsd`. Pass `{ fallback: '0' }` only where an absent count means zero.
- **List deletion preserves place**: collapse the row with `CollapsibleListItem` once the server confirms ([deletion contract](../../docs/UX_DESIGN_GUIDE.md#list-deletion-and-reading-position)).

## API errors and save gating

- **Silent vs toasting requests.** `request()` in `client/src/services/apiCore.js` toasts errors by default. A caller that owns its error UI (`useAsyncAction`, or a `.catch` that swallows on purpose) passes `{ silent: true }` so only one layer toasts; give new API wrappers an `options` parameter.
- Gate server actions on saved settings. Disable dependent actions while settings are dirty or saving.

## Routing and deep linking

- **Tabbed pages use URL params** (`/devtools/history`), not tab state.
- **Deep-link selectable records through route params.** Navigate to the index after clear or delete and render a fallback for stale IDs.
- **Pick the Layout scroll mode by the `<Route>`'s place in `App.jsx`**, never by pathname: `PageLayout` pages go under `<FullWidthMain />`, document/form routes under `<PaddedMain />` (`components/PageShell.jsx`).
- **Moving a page needs no hand-written redirect**: add the old path to its `NAV_COMMANDS` `previousPaths`.

For the full new-page checklist (nav entry shape, palette actions, voice aliases), invoke the `portos-add-page` skill.

## Config drawers

Use `Drawer.jsx` for settings drawers. Keep mutable form state in the parent and use `useDrawerTab` for deep-linkable tabs. Portal fixed overlays to `<body>` ([drawer contract](../../docs/UX_DESIGN_GUIDE.md#config-drawers)).

## Large collections and incremental loading

Growing lists use bounded server pages and query-wide search and counts ([collection contract](../../docs/UX_DESIGN_GUIDE.md#large-collections-and-incremental-loading)).

## Socket-driven UI

Invoke the `portos-socket-ui` skill before wiring a socket-driven view (event-driven state swaps, single-subscriber resources, pending-request tracking, deferred-work guards).
