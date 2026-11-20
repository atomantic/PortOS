# PortOS workspace design guide

Status: reviewed design specification v1, 2026-09-20, for incremental implementation. The review preserves icon-prefixed desktop navigation and the CoS-style compact mobile icon row as explicit product requirements. This is not a claim that existing pages implement the specification. The [audit](research/UX_DESIGN_AUDIT.md) records the evidence. Existing accessibility, routing, privacy, and behavior contracts in `client/src/AGENTS.md` remain binding. The rollout history is in epic [#7791](https://github.com/atomantic/PortOS/issues/7791).

## 1. The product experience

PortOS is a working environment for one person managing many powerful systems. A page should answer **where am I, what needs attention, what can I do, and what happened** without requiring a tutorial or a long scroll.

Use a quiet, structured workspace: clear labels, aligned rows, readable text, restrained surfaces, and deliberate use of horizontal space. Preserve PortOS's theme and personality in the shell; keep dense working areas calm. Optimize for completing a task and comparing evidence, not the number of controls visible.

Every redesign starts with a short page contract:

1. Primary job and primary audience: returning operator, first-time setup, or investigation.
2. Three most frequent user tasks, in order.
3. What must be visible before the first action: state, scope, consequence, or prerequisite.
4. Default view, selection URL, primary action, and completion feedback.
5. Secondary tasks and their named destinations.
6. Narrow layout, failure state, and behavior that must remain compatible.

Do not start by placing existing JSX blocks into a larger grid. Decide what belongs together first.

## 2. Navigation architecture

### One visible home for each destination

- Global navigation chooses an area: Apps, Brain, Models, Settings, and so on.
- A **section navigator** exposes the area's destinations as icon-prefixed, labeled links. Large areas use a vertical navigator on desktop instead of a horizontally overflowing destination strip. Icons are stable visual anchors, not optional decoration to remove for visual minimalism.
- One local row of task views is allowed inside a destination, normally 2–5 short labels. If it needs another nested row, promote the destination or use a record detail.
- Breadcrumbs show ancestry; they do not replace navigation. Search, command palette, and voice are accelerators, never the only discovery path.
- Page titles name the actual destination: “Jev decision scorer” or “Model performance,” rather than spending a separate header row on “Models” alone. The Models shell does this with the active section destination’s label and icon. A destination with two jobs uses a local task row under that title; the title does not change per task, and the destination name is not repeated as the first card heading. Explanations that would be copied onto every group live in one help drawer opened from that row.
- Keep canonical command IDs, current URLs, aliases, and legacy redirects. Moving a link in navigation does not require moving its route.
- `server/lib/navManifest.js` is the route and command source of truth; add grouping metadata through the existing navigation pipeline (`client/src/lib/navPresentation.js` owns icons), never a parallel route array. Keep optional-feature filtering, alphabetical ordering, and command/voice coverage intact.

## 3. Layout system

### Choose a page family

| Family | Structure | Examples |
| --- | --- | --- |
| Collection | Heading and actions → filters → aligned rows → selected detail | Model Library, Apps, Brain Threads |
| Workbench | Task views → input/work area beside output/evidence | Jev test, Playground, comparisons |
| Operations | Compact health summary → actionable records → detail/log inspector | Runtimes, CoS tasks and runs |
| Configuration | Named sections of bounded fields → explicit save state | Integrations, reviewer configuration, Settings |
| Analytics | Scope/filters → comparable results → selected evidence/methodology | Performance, Usage |
| Document or canvas | Bounded reading column or dedicated full-bleed editor | Notes, prose, timelines, 3D editors |

The guide does not force document pages, studios, or canvases into an admin table.

### Responsive geometry

Use the **available content container**, after navigation, as the sizing input. These are initial design tokens to validate, not breakpoints to apply blindly.

| Available workspace width | Composition |
| --- | --- |
| Below 640px | One column; identity, state, action, then work. Details become a routed full-width view or the existing full-screen Drawer. |
| 640–1,023px | One main surface; pair short fields when each has enough room. Open substantial details on demand. |
| 1,024–1,439px | Main + 280–360px supporting column when both remain usable. Otherwise keep one broad results table. |
| 1,440px and above | Use remaining width for comparison, input/output, or selected evidence. Do not stretch prose or add unrelated panels to fill space. |

- Page gutters: 16px narrow, 24px normal desktop, 32px on spacious layouts. Gap scale: 4, 8, 12, 16, 24, 32px.
- Default admin content has no blanket `max-w-6xl` cap. Bound the *content that needs a bound*: explanatory prose at roughly 60–75 characters; short fields around 12–24rem; long paths and editors may grow.
- Use `minmax(0, 1fr)`, `min-width: 0`, wrapping actions, and container-based reflow. A second column must earn its place through the task.
- Keep input beside its result and a selected row beside its evidence; do not put unrelated installation, training, and testing panels in equal columns.
- Avoid masonry for administrative comparisons: users need aligned labels, values, and actions.

### Scrolling and position

Use one primary vertical scroll owner for normal pages. Keep a compact page/task header available where it helps orientation, with correct sticky offsets. Tables may scroll horizontally inside a labeled region; the whole page must not.

Independent pane scrolling is reserved for genuine editors and list/detail workspaces. Use existing `Layout` scroll modes; never add a second full-height container without defining ownership. Preserve filter state and list position when opening and closing a record. Sticky headers and save bars must not cover focused inputs, errors, or the on-screen keyboard.

## 4. Information hierarchy and disclosure

The normal first viewport contains the destination title, relevant state, primary action, view selector/filters, and the beginning of the actual work or results. First-time setup replaces that with the next prerequisite; successful installation should not permanently dominate a returning user's page.

| Information | Placement |
| --- | --- |
| Blocking failure, spend/download consequence, unavailable prerequisite | Visible next to the affected action; never tooltip-only |
| Current state and short explanation needed to choose | Inline label or one sentence |
| Frequent sibling task | Named route-backed view |
| Details of one selected record or occasional configuration | Shared Drawer or supporting inspector |
| Optional explanation, formula, diagnostic data | Explicitly named disclosure, normally one level deep |
| Long tutorial/reference | Linked guide or help view |

Do not hide core tools under “Advanced.” Name destinations by what users do: “Try a decision,” “Integrations,” “Results,” “Training,” “Setup.” Disclosures summarize the hidden state (“4 setup checks passed,” “2 overrides”) and open automatically when they contain a blocking error. Avoid nested accordions and page-length drawers.

Copy has three levels: a short label, one useful sentence, then optional explanation. Explain consequences near the control instead of repeating a paragraph above every group. Define domain terms on first use. Prefer “Time to first token” to an unexplained “TTFT”; preserve scientific distinctions such as agreement versus correctness and unmeasured versus failed.

## 5. Visual language

Use existing theme tokens in `client/src/index.css`; this guide defines a hierarchy, not a parallel palette. Add semantic text/surface tokens centrally if existing mappings cannot express it.

| Element | Starting specification |
| --- | --- |
| Page title | 24px / 32px, semibold; one visible h1 |
| Section title | 16–18px / 24px, semibold |
| Body, inputs, table values | 14px / 20–22px; editable fields at least 16px on touch layouts |
| Secondary annotation | 12px / 16px; essential instructions remain body size |
| Desktop control | 36–40px tall; compact row controls may be 32px with usable target spacing |
| Touch target | At least 44px effective target as the product default |
| Surface radius | 8px controls, 12px panels; pills only for compact states/tags |
| Table row | About 44px default, 36px compact where appropriate; allow growth for wrapped text |

- Use one main workspace surface, quiet separators, and occasional bounded panels. Avoid card-inside-card-inside-card treatments and shadows on every row.
- Retain themed backgrounds in the shell; use opaque or sufficiently solid working surfaces under dense tables and forms. Decorative grids/gradients should not compete with text.
- Accent means selected, interactive, or important. Success, warning, and error also need words/icons. Ordinary configured state should not generate a field of colored badges.
- Use tabular numbers and shared formatters for measurements, counts, and money; align comparable numbers and always label units. Show missing measurements as “Not measured” or a labeled dash, never zero.
- Use compact labels for model names, with full identifiers accessible in detail/copy actions. Do not make hover the only way to distinguish two records.
- Density changes spacing, not legibility. Start with one comfortable default; introduce a saved density preference only where repeated expert use demonstrates value.

## 6. Interaction contracts

Reuse existing primitives (`PageHeader`, `TabPills`, `Drawer`, `FormField`, `Banner`, `OverflowMenu`, `PageSkeleton`) before creating new ones. Do not build a universal schema-driven page engine, and do not replace mature screens wholesale.

### Actions and forms

One primary action per task context. Keep frequent secondary actions visible; put rare/destructive actions in `OverflowMenu` with the existing inline confirmation patterns. Use a verb and object: “Run assessment,” “Save integration settings.” Distinguish navigation from mutations.

Do not silently change persistence semantics during a layout refactor. Existing autosave fields show Saving / Saved / Couldn't save next to their group. A new multi-field workflow may use an explicit save bar when the transaction calls for it; keep drafts through view changes, guard unsaved navigation, and surface validation on the affected tab. Gate dependent runs on saved state and pending saves.

Before model work, show selected provider/runtime, model, operation scope, and relevant cost/download/resource consequences. Opening a view, selecting a row, or reading help does not start provider work. Keep batch-run scope explicit and existing concurrency/spend gates intact.

### Results and asynchronous work

- Row selection is URL-backed; browser Back restores the prior view and selection. A missing/deleted record has a useful recovery link.
- Reading a result never reruns it. Separate “View result” from “Run again.”
- Immediately acknowledge accepted actions with truthful states: Queued, Starting, Running, Completed, Failed, Cancelled. Do not label queued work Running.
- Keep active run progress and cancellation reachable across local views. Show determinate progress only when a meaningful denominator exists.
- Retain prior results with a visible stale/error marker on failed refresh. Empty, loading, unavailable, partial, stale, and measured-zero states are distinct.
- Use inline errors and a working retry at the failed region. Avoid toasting the same failure twice or sending routine lifecycle outcomes as notifications.

### Tables and comparisons

Rows serve comparison; details serve inspection. Show identity, the few decision-making values, freshness/status, and a clear result link. Move long narratives and tuning dumps to detail. Keep sorting/filter scope visible and URL-backed when useful to share.

For Performance, never combine characters/s and tokens/s into the same unlabeled rank. Include context length, runtime/tuning, timing basis, measurement age, and missing evidence in the comparison/detail contract. Capability evidence is task-specific; do not market a structural writing check as literary quality or a composite score as universal intelligence.

## 10. Acceptance and evaluation

For every migrated page, review these scenarios with synthetic data:

- At 1,440×900 and 1,920×1,080, title/state/action and the start of useful work are visible without scrolling past setup or reference prose.
- At 1,024×768, 768×1,024, 390×844, and 320px width, controls remain available; no page-level horizontal scroll or clipping. Tables may use their own horizontal region.
- At 200% text zoom and 400% page zoom, content reflows and keyboard focus is not covered. Check light, dark, and at least one supported decorative theme.
- Keyboard-only users can navigate, select, operate, close details, and return to their origin. Forms have associated labels; status changes are announced without excessive repetition; non-modal inspectors do not trap focus. Every desktop navigation destination has its icon prefix; mobile section and task rows retain unique icons, identical accessible names, selected-state cues, usable targets, overflow chevrons, and automatic reveal of focused/selected destinations. A supplemental sheet must not become the only mobile navigation path.
- Test first visit, ready/idle, empty, loading, partial/stale, unavailable, save failure, running, cancellation, and completion. Preserve drafts across local view switches.
- Back/forward, refresh, copied deep links, command palette, voice destinations, optional features, and legacy links still work.
- No provider call occurs from navigation. Batch actions disclose scope; dependent actions respect saved-state gates.

Run a lightweight task study before/after: find Jev from Models without search; disable a source; score two options; inspect why a model comparison is stale; compare two measurements at the same context; locate and inspect a failed task. Record completion, wrong turns, navigation steps, scroll distance to the first action, and recovery from errors. Set improvement targets from the baseline; do not claim usability gains from screenshots alone.

Use focused behavior tests at rendered interactions and route boundaries plus visual checks for responsive geometry. Do not add tests that merely assert copied class strings. This documentation does not certify accessibility or performance.

## 11. Reusable redesign brief

> Apply `docs/UX_DESIGN_GUIDE.md` to this page. Read its nested conventions and audit the current user tasks, routes, states, and shared components. State the primary job and select the page family. Put the useful work first, use desktop width for related work/evidence, and specify narrow-screen reflow. Preserve behavior, privacy, saved-state gates, deep links, and explicit provider consent. Produce a before/after content map, reuse existing primitives, implement a bounded slice, and verify representative viewport, keyboard, loading, failure, and route scenarios. Report what was observed versus inferred; use only synthetic data in published evidence.

## Sources and rationale

The page families, spacing, and navigation grouping are PortOS design defaults based on the [repository/live audit](research/UX_DESIGN_AUDIT.md), not externally mandated rules.

- [NN/g: Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) supports moving secondary detail behind explicit requests while keeping primary work clear. Disclosure does not justify hiding sibling destinations.
- [W3C: Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) explains narrow-width/zoom reflow and the exception for two-dimensional tables within their own scroll region.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies the accessibility baseline, including contrast, focus, keyboard access, labels, and target-size requirements. The 44px touch target above is a PortOS design default, not a claim that every WCAG AA target must be 44px.

## List deletion and reading position

Deleting an item keeps the populated list and its scroll container mounted. After server success, use `CollapsibleListItem` to fade and collapse the row, including its spacing, so following content slides up; remove the record locally on exit. Preserve search, filters, pagination and unrelated selection. Refresh summary counts separately. Keep failed deletions visible and actionable, prevent duplicate pending requests, honor reduced motion, and transfer keyboard focus without scrolling. Never show a whole-list loading placeholder as deletion feedback. Brain MemoryTab is the reference implementation across Memories, People, Projects, Ideas and Admin.


## Realtime updates, not polling

API polling is an anti-pattern in PortOS. Data on screen stays current because the server **pushes** changes over Socket.IO (or a job's SSE stream) and the UI **reacts immediately** — not because a timer re-fetches it every N seconds. Polling wastes server work (several PortOS polls fan out to `pm2 jlist`, Ollama, git, or peer HTTP hops on every tick), keeps background tabs on other tailnet machines busy, and still shows stale state for up to one interval.

- **Own mutations update the UI from the response.** After a create/update/delete succeeds, apply the returned record (or the known change) to local state at once. Never follow a mutation with "wait for the next poll", a fixed `setTimeout` refetch, or a spinner that clears only when a timer notices the change.
- **Everyone else's changes arrive as events.** Background jobs, agents, schedulers, peers, and other tabs emit a Socket.IO event when they change a record (`<domain>:changed`, `<record>:upserted`, `<job>:progress` / `:completed`). Subscribe through `useSocketSubscription` / `useSocket` or the media-job hooks, then patch the affected record or re-read just that resource.
- **Missing event? Add it on the server.** If the change has no event today, emit one from the service that performs it and declare its payload in `server/lib/socketEventContracts.js`. A client-side poll is not an acceptable substitute for a missing emit.
- **Recover, don't poll, for gaps.** Reconcile with one fetch on socket reconnect and when the tab becomes visible again; that covers events missed while disconnected without a recurring timer.
- **Long-running work streams progress.** Renders, imports, installs, and agent runs report progress and completion over their socket/SSE channel (`useMediaJobProgress`, `useSseProgress`, `usePipelineProgress`). Do not poll a job-status endpoint until it reports `completed`.
- **Sanctioned exceptions** are sources that genuinely cannot push: sampled hardware telemetry for a visible inspector (GPU utilization), an external system that offers no callback, and PortOS restarting itself (the socket is down, so `usePortosRestartWatch` probes health). These use `useAutoRefetch` (visibility-gated, single-flight), run only while their consumer is open, and carry a one-line justification at the call site. `client/src/test/guards/ui/pollingConventions.test.js` bans raw `setInterval` in views; routing a new data poll through `useAutoRefetch` does not by itself make it acceptable.

Existing polls are being migrated to socket events incrementally, tracked by [#8531](https://github.com/atomantic/PortOS/issues/8531), [#8532](https://github.com/atomantic/PortOS/issues/8532), [#8533](https://github.com/atomantic/PortOS/issues/8533), [#8534](https://github.com/atomantic/PortOS/issues/8534), [#8530](https://github.com/atomantic/PortOS/issues/8530), [#8535](https://github.com/atomantic/PortOS/issues/8535), [#8536](https://github.com/atomantic/PortOS/issues/8536), [#8517](https://github.com/atomantic/PortOS/issues/8517). Don't copy an existing poll as precedent for new code.

## Large collections and incremental loading

A growing collection must remain usable with hundreds, thousands, or more records. This applies to Brain inbox and memory, CoS tasks/agents, media and image history, and any new collection surface.

- Use event-driven invalidation for stable collections and reference data. Fetch once when needed, update the affected resource on websocket notification, and recover missed updates on reconnect. Do not attach a recurring whole-page fetch to agents, apps, providers, or history. Poll live telemetry only when its visible inspector needs it; pause when hidden and document any fallback cadence.
- Fetch only data used by the active route/tab. Shared shells use scalar summaries; inactive panels do not fetch, poll, or refresh collections on socket events. Deduplicate in-flight reads and retire responses after navigation or filter changes.
- Start with a bounded server page (normally 25–50 records, with a server-enforced ceiling). Send card/row projections, never full transcripts, prompts, binary assets, or duplicated history. Load record details when opened and full editable values before editing. Use thumbnails and lazy image decoding/loading for media lists.
- Use stable cursor pagination for changing histories (timestamp plus unique id as a tie-breaker); deduplicate appended records by id. Apply filters/search/order on the server before pagination. If search is intentionally local, label it “Search loaded results.” Counts describe their scope; do not equate loaded rows with the total.
- Reuse `client/src/hooks/usePagedCollection.js` for request state and `client/src/components/ui/InfiniteScrollFooter.jsx` for scrolling. The footer observes the actual visible area, keeps a keyboard-accessible Load more button, announces loading/end states, and pauses automatic fetching on error until an explicit retry. Preserve already loaded rows on a failed next page. Disabled/collapsed collections do not fetch.
- Filter changes reset the cursor and cancel obsolete requests. Mutation handling must preserve stable identity and prevent deleted records returning from stale requests. Keep deep links to records outside the loaded pages; fetch the selected record directly. Background updates must not restart a growing history on every event or jump the reader's scroll position.
- Infinite fetching does not bound the DOM: for sessions retaining thousands of rows, use measured virtualization or an explicit bounded page/window with preserved selection and scroll. Do not virtualize small bounded lists without evidence.
- Verify the public behavior: initial and next-page request limits, unrelated-tab silence, no duplicate concurrent loads, stale-response rejection, retry without skipped pages, end-of-results, deep links, and keyboard/mobile access. Measure transfer and rendered-row count using synthetic large fixtures; never put private records into tests or reports.

Adoption is incremental. CoS uses the shared request and footer primitives; Media History reuses the footer with its existing `useGalleryPage` server-filtered adapter; existing collection surfaces require scoped migrations rather than a claim that this document alone makes them conform.

## Config drawers

Settings-over-a-feature surfaces use the shared `client/src/components/Drawer.jsx`, never a hand-rolled `fixed inset-y-0 right-0` clone (design record: `docs/plans/archive/2026-07-01-drawer-ux-redesign.md`).

- **Size**: `size` is `sm` 520px, `md` 640px, `lg` 720→880px, `xl` up to 1100px; widen large forms so they lay out in columns, keep small dialogs `sm`. Mobile is always full-width. `widthClass` is a back-compat override.
- **Tabs**: a large surface (many fields or groups, e.g. Edit App) uses `tabs={[{ id, label, icon?, count? }]}` + `activeTab`/`onTabChange` and renders only the active tab. A medium form that should stay fully visible uses labeled sections instead (`ImageGenSettingsForm`'s `grouped` prop).
- **Per-tab scroll** remounts the body on switch, so **all mutable form state lives in the parent**, never in uncontrolled inputs (see `EditAppDrawer.jsx`). Validate unmounted tabs at Save and `setActiveTab()` to the failing one.
- **Tab bar**: the built-in layout wires `TabPills` (`mobileCompact` under `sm`). A surface hosted in both a drawer and a page (like `ImageGenTab`) renders its own `<TabPills variant="pills" mobileCompact>`.
- **Deep-linkable tab**: drive `activeTab` from `useDrawerTab(paramName, defaultTab, tabIds)` (`client/src/hooks/useDrawerTab.js`); the caller names the param (`appTab`, `mediaTab`) and passes the id list so a stale link falls back to `defaultTab`.
- **Long-lived forms** set `closeOnEsc={false}` / `closeOnBackdrop={false}`.
- **The overlay is always portaled to `<body>`**; never re-nest it. A `filter`/`backdrop-filter`/`transform` ancestor (glass themes give `.bg-port-card` a `backdrop-filter`) becomes a fixed element's containing block (#4150). Any new hand-rolled `fixed inset-0` overlay is portaled too (`Modal`'s `usePortal`, `GalleryImagePicker.jsx`).
- **Examples**: `client/src/components/apps/EditAppDrawer.jsx` (built-in tabs, `size="lg"`, `useDrawerTab('appTab', …)`) and `client/src/components/settings/ImageGenTab.jsx` (internal pill sub-tabs, `useDrawerTab('mediaTab', …)`).

## Narrow monitors and embedded containers

Responsive acceptance is based on **available content width**, not just screen width. An expanded sidebar, inspector, drawer or dashboard grid can leave a 240–480px panel on a desktop monitor. A viewport `sm:` row still activates there and can push controls outside its card.

- Put a named `@container` on the page or reusable component root and query that container for internal layout. A container cannot query itself: apply variants to descendants. Keep device/viewport affordances separate from content layout.
- Stack fixed side rails until the container fits both a useful primary column and the rail plus gaps. Use `minmax(0,1fr)` for flexible grid tracks and `min-w-0` on shrinking flex/grid children. Container thresholds must account for padding and gaps.
- Toolbars and action groups wrap; search inputs have `min-w-0` and a bounded width. Keep labels, actions, focus order and all filter choices available. Long user strings wrap (`overflow-wrap:anywhere`) or truncate with an accessible full-value path.
- Dashboard widgets must work at 240, 320 and 480px container widths on a 1440px desktop. Prefer content-sized auto-fit grids with a minimum clamped to `100%`; a six-column app grid must not remain six columns in a small tile.
- Never fix overflow by hiding it at the page/card root. Intentional tables, timelines and code panes may scroll locally, with keyboard access and a visible cue. Measure both scroll dimensions and child rectangles: clipping can hide a defect without increasing document scroll width.

Before accepting a new or changed page, check 320, 390, 768, 1024, 1280 and 1440px viewports, expanded/collapsed navigation, 200% zoom, and narrow embedded containers. Exercise empty, populated, loading and failure states, long synthetic names/URLs and all action groups. Record the route/component, viewport and container width, state and observed result; mark untested states explicitly. The scheduled UX audit includes these checks and deduplicates findings with the mobile-responsive audit. Structural convention tests supplement real browser geometry checks; passing them does not certify every route.
