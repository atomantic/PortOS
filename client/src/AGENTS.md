# Client conventions (`client/src/`)

These apply to React/Vite client code; the root `AGENTS.md` rules always apply. Rules marked *enforced* have a tree-wide test under `client/src/` that names the offender; the test file carries any allowlist.

## UI conventions

- **Actions look like buttons**: a border, padding and hover/focus treatment; plain text links are for navigation and references. Keep controls usable on touch.
- **Fix missing prerequisites in place**: show the missing tool or setting beside the blocked action ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)).
- **Timestamps display in browser-local time** via the shared formatters in `utils/formatters.js`; never render an ISO/UTC string. ISO stays for transport and persistence; explicit schedule timezones and date-keyed reporting keep their semantics.
- **Admin workspace design**: new or redesigned admin pages follow [the workspace design guide](../../docs/UX_DESIGN_GUIDE.md), incrementally; it does not authorize unrelated behavior changes or a global CSS rewrite.
- **No browser `alert`/`confirm`/`prompt`**: use inline confirmations or toasts. *Enforced:* Biome `suspicious/noAlert`.
- **Form labels pair `htmlFor` with the input's `id`**; visual styling doesn't create the association.
- **Narrow containers on desktop** follow the [narrow-container contract](../../docs/UX_DESIGN_GUIDE.md#narrow-monitors-and-embedded-containers): container queries, shrinkable grid/flex children, wrapping actions, long-string handling. Verify child rectangles as well as scroll dimensions; hiding overflow is not a fix.
- **Mobile responsive:** `grid-cols-N` (N > 3) needs a breakpoint ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)). *Enforced:* `test/guards/ui/responsiveGridConventions.test.js`.
- **A shared primitive baking in `inline-flex` yields to the caller's display utility** (Tailwind v4 sorts `.inline-flex` after `.hidden`, so it wins). `Pill` does (`OWN_DISPLAY` in `components/ui/Pill.jsx`); `InfoTooltip`, `CopyableId` and `ProvenanceChip` need the fix at their first `hidden md:` call site.
- **A fixed-width popover of 256px or more (`w-64`+ or an equivalent `w-[…]`) also carries `max-w-[calc(100vw-1rem)]`**: `Layout`'s shell is `overflow-x-hidden`, so a too-wide panel is clipped, not scrollable. *Enforced:* `test/guards/ui/popoverClampConventions.test.js`.
- **A hover-revealed control stays visible on touch**: Tailwind v4 wraps `hover:` in `@media (hover: hover)`, so scope the hide to hover devices (`[@media(hover:hover)]:sm:opacity-0`, see `components/Layout.jsx`) or restore it with `pointer-coarse:opacity-100`. *Enforced:* `test/guards/a11y/hoverRevealConventions.test.js`.
- **An icon-only button gets a 44px hit area in both dimensions** (`min-h-[44px] min-w-[44px]`, or `pointer-coarse:min-h-11 pointer-coarse:min-w-11` for a dense desktop row). Bare `<summary>` rows get it from `src/index.css`. *Enforced:* `test/guards/a11y/hitAreas.test.js`.
- **A dnd-kit drag handle carries `touch-none`** on the element spreading `listeners`, or touch drags cancel as pans. A source that must keep native panning (the Video Timeline segment block) uses a long-press `TouchSensor`. *Enforced:* `test/guards/a11y/dragHandleTouchConventions.test.js`.
- **Size form fields for their content**: share rows when there is room, stack when narrow ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)).
- **A sub-nav that doesn't fit a phone collapses to icon links, never a `<select>`** (#7283 was reverted): reuse `TabPills` (`mobileCompact`), never roll a new tab bar ([contract](../../.claude/skills/portos-add-page/SKILL.md#sub-nav-on-a-phone)). *Enforced:* `test/guards/ui/subNavConventions.test.js`.
- **Above the fold**: actionable content stays visible without scrolling.
- **No hardcoded localhost**: build URLs from `window.location.hostname` (used over Tailscale).
- **Chrome floating over media uses `.port-media-overlay`** (`-strong`, `-item`, `-divider`; see `index.css`, including when to use `.always-dark`). Never `bg-black/NN` + `text-white`/`text-gray-N00`: day mode darkens the text on the scrim. Older overlays still do (#3796); don't copy the neighbor.
- **Alphabetical navigation**: sidebar items in `SidebarNav.jsx` (driven by `navPresentation.js`) are alphabetical after the top single-row section (Dashboard, Review Hub, Eidoverse) and its separator, with Goals placed alphabetically between sections; children in collapsible sections are alphabetical too.
- **Space is a global push-to-talk hotkey.** A surface owning Space claims it with `useKeyCapture`; add global-key guards in `shouldIgnoreGlobalKey` (`lib/a11yKeyboard.js`), never at one caller (#4748) ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#keyboard-ownership-and-web-storage)).
- **Never `autoFocus` a control that appears on a key-submit**: a still-down Enter activates it ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)).
- **Web Storage goes through `lib/safeStorage.js`**; raw `localStorage`/`sessionStorage` throws in Safari private mode, sandboxed iframes and at quota (#5689) ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#keyboard-ownership-and-web-storage)). *Enforced:* `client/lint-no-raw-web-storage.grit`.
- **Push, don't poll.** Fetch once, then update from Socket.IO events (`useSocketSubscription`, the media-job hooks) and apply your own mutation's response immediately. A change with no event gets a server emit (declared in `server/lib/socketEventContracts.js`), not a client poll ([exceptions](../../docs/UX_DESIGN_GUIDE.md#realtime-updates-not-polling)).
- **Poll only via `useAutoRefetch`**, never `setInterval` ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)). *Enforced:* `client/lint-no-view-interval.grit`.
- **No local binding shadows a timer or `fetch`** (`setInterval`, `setTimeout`, `clearInterval`, `clearTimeout`, `requestAnimationFrame`, `cancelAnimationFrame`, `fetch`); a later call in that scope silently hits the local (#5728). Name the binding for what it holds. *Enforced:* `client/lint-no-global-shadow.grit`.
- **An async effect keyed to a switchable identity drops superseded responses** (`let active = true;`, gate every `set*` on it, or a generation ref; #7242; `useMounted()` does not cover this; [pattern](../../.claude/skills/portos-socket-ui/SKILL.md)). *Enforced:* `test/guards/ui/asyncEffectDisposalConventions.test.js`.
- **User-facing counts and amounts use `formatCount` / `formatUsd`** (`utils/formatters.js`; en-US grouped: `2,762`, `$4,610.09`). `formatCount` shows `—` for missing input; pass `{ fallback: '0' }` where absent reads zero. *Enforced:* `client/lint-use-shared-number-formatters.grit` (no bare `.toLocaleString(`).
- **List deletion preserves place**: collapse the row with `CollapsibleListItem` once the server confirms ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)).
- **Reactive updates**: after a create/update/delete, update local state (`setState(prev => prev.filter(...))`) instead of refetching the list.

## API errors and save gating

- **Silent vs toasting requests.** `request()` in `client/src/services/apiCore.js` toasts errors by default. A caller that owns its error UI (`useAsyncAction`, or a `.catch` that swallows on purpose) passes `{ silent: true }` so only one layer toasts; give new API wrappers an `options` parameter.
- **"Run Now" gates on saved state, not the form.** A button that triggers server work reading server-side settings stays disabled while the form is dirty or saving: track a `saved*` value per dependent setting, updated on successful save. A tooltip warning is not enough.
- **In-flight saves gate dependent actions too.** While an async PATCH of a field is pending, disable buttons that read it: set a `<field>Saving` flag before the PATCH, clear it in `.finally()` (`lengthProfileSaving` in `client/src/pages/PipelineIssue.jsx`).

## Routing and deep linking

- **Tabbed pages use URL params** (`/devtools/history`), not tab state.
- **Every selectable record is deep-linkable**: selection is a route param, never `useState` ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)).
- **Pick the Layout scroll mode by the `<Route>`'s place in `App.jsx`**, never by pathname: `PageLayout` pages go under `<FullWidthMain />`, document/form routes under `<PaddedMain />` (`components/PageShell.jsx`).
- **Moving a page needs no hand-written redirect**: add the old path to its `NAV_COMMANDS` `previousPaths`.

For the full new-page checklist (nav entry shape, palette actions, voice aliases), invoke the `portos-add-page` skill.

## Config drawers

Settings drawers use `client/src/components/Drawer.jsx`, never a hand-rolled `fixed` clone ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)).

## Large collections and incremental loading

Growing lists use bounded server pages and query-wide search and counts ([detail](../../docs/INSTRUCTION_RULE_DETAIL.md#client-rules)).

## Socket-driven UI

Invoke the `portos-socket-ui` skill before wiring a socket-driven view (event-driven state swaps, single-subscriber resources, pending-request tracking, deferred-work guards).
