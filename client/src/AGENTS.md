# Client conventions (`client/src/`)

These apply to React/Vite client code; the root `AGENTS.md` rules always apply. Rules marked *enforced* have a tree-wide test under `client/src/` that names the offender; the test file carries any allowlist.

## UI conventions

- **Actions look like buttons**: a border, padding and hover/focus treatment; plain text links are for navigation and references. Keep controls usable on touch.
- **Fix missing prerequisites in place.** Show the missing tool or setting beside the blocked action and preserve the user's work; for linked records, locks or approvals link to the exact place it's resolved, and keep existing authority checks ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)).
- **Timestamps display in browser-local time** via the shared formatters in `utils/formatters.js`; never render an ISO/UTC string. ISO stays for transport and persistence; explicit schedule timezones and date-keyed reporting keep their semantics.
- **Admin workspace design**: new or redesigned admin pages follow [the workspace design guide](../../docs/UX_DESIGN_GUIDE.md), incrementally; it does not authorize unrelated behavior changes or a global CSS rewrite.
- **No `window.alert`/`confirm`**: use inline confirmations or toasts.
- **Form labels pair `htmlFor` with the input's `id`**; visual styling doesn't create the association.
- **Narrow containers on desktop** follow the [narrow-container contract](../../docs/UX_DESIGN_GUIDE.md#narrow-monitors-and-embedded-containers): container queries, shrinkable grid/flex children, wrapping actions, long-string handling. Verify child rectangles as well as scroll dimensions; hiding overflow is not a fix.
- **Mobile responsive, always.** A `grid-cols-N` with N > 3 and no `…:grid-cols-*` in the same class string is a bug: give text-bearing cards a phone default and widen by breakpoint; a wider gap is not a column breakpoint ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)). *Enforced:* `responsiveGridConventions.guard.test.js`.
- **A shared primitive baking in `inline-flex` yields to the caller's display utility** (Tailwind v4 sorts `.inline-flex` after `.hidden`, so it wins). `Pill` does (`OWN_DISPLAY` in `components/ui/Pill.jsx`); `InfoTooltip`, `CopyableId` and `ProvenanceChip` need the fix at their first `hidden md:` call site.
- **A fixed-width popover of 256px or more (`w-64`+ or an equivalent `w-[…]`) also carries `max-w-[calc(100vw-1rem)]`**: `Layout`'s shell is `overflow-x-hidden`, so a too-wide panel is clipped, not scrollable. *Enforced:* `popoverClampConventions.guard.test.js`.
- **A hover-revealed control stays visible on touch**: Tailwind v4 wraps `hover:` in `@media (hover: hover)`, so scope the hide to hover devices (`[@media(hover:hover)]:sm:opacity-0`, see `components/Layout.jsx`) or restore it with `pointer-coarse:opacity-100`. *Enforced:* `hoverRevealConventions.guard.test.js`.
- **An icon-only button gets a 44px hit area in both dimensions** (`min-h-[44px] min-w-[44px]`, or `pointer-coarse:min-h-11 pointer-coarse:min-w-11` for a dense desktop row). Bare `<summary>` rows get it from `src/index.css`. *Enforced:* `a11y/*.conventions.test.js`.
- **A dnd-kit drag handle carries `touch-none`** on the element spreading `listeners`, or touch drags cancel as pans. A source that must keep native panning (the Video Timeline segment block) uses a long-press `TouchSensor`. *Enforced:* `dragHandleTouchConventions.guard.test.js`.
- **Size form fields for their content.** Short selects and numeric inputs share rows when there is room and stack when narrow; prefer bounded wrapping grids over full-width controls, with no global input width limits ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)).
- **A sub-nav that doesn't fit a phone collapses to icon links, never a `<select>`** (#7283 was reverted): reuse `TabPills` (`mobileCompact`), never roll a new tab bar ([contract](../../.claude/skills/portos-add-page/SKILL.md#sub-nav-on-a-phone)). *Enforced:* `subNavConventions.guard.test.js`.
- **Above the fold**: actionable content stays visible without scrolling.
- **No hardcoded localhost**: build URLs from `window.location.hostname` (used over Tailscale).
- **Chrome floating over media uses `.port-media-overlay`** (`-strong`, `-item`, `-divider`; see `index.css`, including when to use `.always-dark`). Never `bg-black/NN` + `text-white`/`text-gray-N00`: day mode darkens the text on the scrim. Older overlays still do (#3796); don't copy the neighbor.
- **Alphabetical navigation**: sidebar items in `Layout.jsx` are alphabetical after the top single-row section (Dashboard, Review Hub, Eidoverse, Goals) and its separator; children in collapsible sections are alphabetical too.
- **Space is a global push-to-talk hotkey.** A surface owning Space claims it with `useKeyCapture`; add global-key guards in `shouldIgnoreGlobalKey` (`lib/a11yKeyboard.js`), never at one caller (#4748) ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#keyboard-ownership-and-web-storage)).
- **Never `autoFocus` a control that appears in response to a key-submit**: the still-down Enter activates it the moment it mounts; keep the submitting element focused (`readOnly`, not `disabled`) and filter `e.repeat` ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)).
- **Web Storage goes through `lib/safeStorage.js`**; raw `localStorage`/`sessionStorage` throws in Safari private mode, sandboxed iframes and at quota (#5689) ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#keyboard-ownership-and-web-storage)). *Enforced:* `client/lint-no-raw-web-storage.grit`.
- **Push, don't poll.** Fetch once, then update from Socket.IO events (`useSocketSubscription`, the media-job hooks) and apply your own mutation's response immediately. A change with no event gets a server emit (declared in `server/lib/socketEventContracts.js`), not a client poll ([exceptions](../../docs/UX_DESIGN_GUIDE.md#realtime-updates-not-polling)).
- **A sanctioned poll uses `useAutoRefetch(fetchFn, intervalMs, { enabled, pollOnly: true })`** (`hooks/useAutoRefetch.js`), never a hand-rolled `setInterval`; it pauses in hidden tabs (#5697); pass the gate as `enabled`, not an early `return` ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)). *Enforced:* `pollingConventions.guard.test.js`.
- **No local binding shadows a timer or `fetch`** (`setInterval`, `setTimeout`, `clearInterval`, `clearTimeout`, `requestAnimationFrame`, `cancelAnimationFrame`, `fetch`); a later call in that scope silently hits the local (#5728). Name the binding for what it holds. *Enforced:* `globalShadowConventions.guard.test.js`.
- **An async effect keyed to a switchable identity drops superseded responses** (`let active = true;`, gate every `set*` on it, or a generation ref; #7242; `useMounted()` does not cover this; [pattern](../../.claude/skills/portos-socket-ui/SKILL.md)). *Enforced:* `asyncEffectDisposalConventions.guard.test.js`.
- **User-facing counts and amounts use `formatCount` / `formatUsd`** (`utils/formatters.js`; en-US grouped: `2,762`, `$4,610.09`). `formatCount` shows `—` for missing input; pass `{ fallback: '0' }` where absent reads zero. *Enforced:* `numberFormattingConventions.guard.test.js` (no bare `.toLocaleString(`).
- **List deletion preserves place** ([contract](../../docs/UX_DESIGN_GUIDE.md#list-deletion-and-reading-position)): after the server confirms, collapse the row with `components/ui/CollapsibleListItem`, then remove it from local state; keep the list, scroll container, filters and pagination mounted and failures visible, and move focus to a surviving row with `preventScroll` ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)).
- **Reactive updates**: after a create/update/delete, update local state (`setState(prev => prev.filter(...))`) instead of refetching the list.

## API errors and save gating

- **Silent vs toasting requests.** `request()` in `client/src/services/apiCore.js` toasts errors by default. A caller that owns its error UI (`useAsyncAction`, or a `.catch` that swallows on purpose) passes `{ silent: true }` so only one layer toasts; give new API wrappers an `options` parameter.
- **"Run Now" gates on saved state, not the form.** A button that triggers server work reading server-side settings stays disabled while the form is dirty or saving: track a `saved*` value per dependent setting, updated on successful save. A tooltip warning is not enough.
- **In-flight saves gate dependent actions too.** While an async PATCH of a field is pending, disable buttons that read it: set a `<field>Saving` flag before the PATCH, clear it in `.finally()` (`lengthProfileSaving` in `client/src/pages/PipelineIssue.jsx`).

## Routing and deep linking

- **Tabbed pages use URL params** (`/devtools/history`), not tab state.
- **Every selectable record is deep-linkable**: an opened project, item, scene, editor or master-detail selection is a route param (`/music-video/:projectId`), never `useState`/`selectedId`; register both the index and `:id` routes in `App.jsx`, and the base path in `NAV_COMMANDS` ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)).
- **Pick the right Layout scroll mode** by where the `<Route>` sits in `App.jsx`, never by pathname: `PageLayout` pages go under `<FullWidthMain />`, document/form routes under `<PaddedMain />` (`components/PageShell.jsx`; exceptions: `docs/research/PAGE_LAYOUT_AUDIT.md`).
- **Moving a page needs no hand-written redirect**: add the old path to its `NAV_COMMANDS` `previousPaths`.

For the full new-page checklist (nav entry shape, palette actions, voice aliases), invoke the `portos-add-page` skill.

## Config drawers

Settings-over-a-feature surfaces use the shared `client/src/components/Drawer.jsx`, never a hand-rolled `fixed inset-y-0 right-0` clone; all mutable form state lives in the parent and the overlay is always portaled to `<body>` (#4150). Sizes, tabs, Esc/backdrop: [the drawer contract](../../docs/UX_DESIGN_GUIDE.md#config-drawers) ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)).

## Large collections and incremental loading

Every potentially growing list follows [the collection-loading contract](../../docs/UX_DESIGN_GUIDE.md#large-collections-and-incremental-loading): bounded server pages, socket invalidation instead of whole-list polls, and query-wide search/counts (never only loaded rows); client-side slicing of an unbounded response is not pagination ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules-moved-from-clientsrcagentsmd)).

## Socket-driven UI

Invoke the `portos-socket-ui` skill before wiring a socket-driven view (event-driven state swaps, single-subscriber resources, pending-request tracking, deferred-work guards).
