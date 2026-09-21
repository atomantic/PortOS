# PortOS workspace design guide

Status: reviewed design specification v1, 2026-09-20, for incremental implementation. The review preserves icon-prefixed desktop navigation and the CoS-style compact mobile icon row as explicit product requirements. This is not a claim that existing pages implement the specification. The [audit](UX_DESIGN_AUDIT.md) records the evidence and pilot scope. Existing accessibility, routing, privacy, and behavior contracts in `client/src/AGENTS.md` remain binding.

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
- Page titles name the actual destination: “Jev decision scorer” or “Model performance,” rather than spending a separate header row on “Models” alone.
- Keep canonical command IDs, current URLs, aliases, and legacy redirects. Moving a link in navigation does not require moving its route.

### Models proposal

Expose all current destinations in the Models navigator, including those currently missing from its top-level tabs. Groups are visible labels, not extra pages or collapsed default categories. Keep groups and links alphabetical to preserve the existing navigation convention.

| Group | Destinations (existing paths retained) |
| --- | --- |
| Connect | AI Services (`/ai/services`), Harnesses (`/ai/harnesses`), Providers (`/ai/presets`), Runtimes (`/models/llms-runtimes`) |
| Evaluate | Comparison (`/models/comparison`), Performance (`/models/performance`), Playground (`/local-llm/playground`) |
| Library | 3D (`/models/3d`), Embeddings (`/models/embeddings`), LoRAs (`/models/loras`), Media (`/models/media`), Model Library (`/models/llms`), Training (`/models/training`) |
| Operate | Quota Burn (`/devtools/quota-burn`), Status (`/models/status`), Subscriptions (`/models/subscriptions`), Usage (`/devtools/usage`) |
| Policies | Abuse Guard (`/models/llms/abuse`), Code Reviewers (`/models/code-reviewers`), Jev decision scorer (`/models/llms/jev`) |

“Policies” groups tools by their integration-management job; Jev remains a decision scorer, not a security guarantee. Confirm this label through the findability exercise below. Keep “jev” and “LLMs” as search/voice aliases even if visible labels expand.

The desktop pilot uses the existing compact global icon rail plus a 208–240px section navigator with an icon before every destination label. Preserve the user's global-sidebar preference: when that sidebar is expanded, present the same grouped Models destinations there and suppress the duplicate section column. Do not stack an expanded global sidebar, a second expanded section sidebar, and a third page sidebar. Long destination lists may scroll vertically with the selected item kept in view; never truncate the final group out of reach.

On smaller screens, retain the **CoS-style `TabPills mobileCompact` icon row** for fixed section destinations and local task views. Each destination keeps its distinct icon, accessible name, selected state, and overflow chevrons; selection scrolls into view. Section destinations remain reachable directly from this row. A labeled “All Models destinations” button may additionally open the grouped icon-and-label navigator for discovery; a sheet, hamburger-only menu, text-only strip, or select must not replace the icon row. Keep the current destination title visible for touch users. Unbounded record pickers remain distinct from fixed navigation.

Desktop and mobile use the same icon identity for a destination. Prefer existing `NAV_PRESENTATION` entries; add missing Jev and Abuse Guard entries with distinct icons before promotion. Reuse the existing Scale icon for Jev; select a guard icon distinct from Code Reviewers' ShieldCheck. Every fixed task view also needs an icon. The CoS navigation at `client/src/pages/ChiefOfStaff.jsx` is the reference interaction, not a feature to redesign away.

Grouped links use a named navigation landmark and `aria-current="page"`; existing `TabPills` retain shared tab keyboard/panel semantics. Decorative icons use `aria-hidden`; mobile accessible names match desktop labels. Selection has a non-color cue, keyboard focus remains visible and scrolls into view, and icon-only controls retain effective touch targets and focus/hover labels. Do not require hover to identify the current destination. Hidden desktop/mobile navigation copies must not remain in the tab order.

### Implementation ownership

`server/lib/navManifest.js` remains the route and command source of truth. Add grouping/presentation metadata through the existing navigation pipeline; `client/src/lib/navPresentation.js` owns icons/presentation. Do not introduce a manually maintained parallel route array. Preserve optional-feature filtering on the client, selected disabled-feature routes, alphabetic ordering, and command/voice coverage. Register any new task-view routes and route-backed record selections when they ship. The same Models navigator and active-destination resolution must cover cross-prefix hosts (`/ai/*`, `/devtools/usage`, `/devtools/quota-burn`, `/local-llm/playground`) and retain the owning destination on detail routes.

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

Use existing theme tokens in `client/src/index.css`; this guide proposes a hierarchy, not a parallel palette. Add semantic text/surface tokens centrally if existing mappings cannot express it.

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

## 7. Jev pilot specification

Default ready-state view: **Try a decision**. Keep all five views directly visible:

| View | Main workspace | Supporting information |
| --- | --- | --- |
| Try a decision | Premise and answer options beside the resulting choice or abstention | Runtime state, model loaded/idle, concise margin explanation |
| Integrations | Source rows with current mode and one-line consequence; scope advisory separate | Global integration state, effective policy/overrides, link to canonical Abuse Guard policy editor |
| Results | Agreement, abstention, and unavailable counts by decision | Sample counts and interpretation; agreement is not correctness |
| Training | Project-head eligibility, baseline comparison, train/adopt actions | Local-only data boundary, adoption blockers, current progress |
| Setup | Installation stages, repair/download actions and logs | Model revision, size, runtime lifecycle and unload action |

At the top show installation readiness and integration enablement as **separate states**. “Ready” must not imply that automatic integrations are enabled. A compact Setup link can say “4 checks passed”; detailed installation cards live in Setup. If unavailable, show a clear “Complete setup” action without hiding other views or historical evidence.

Preserve modes and consequences exactly: Shadow compares without replacing the chat answer; Prefer local falls back to chat on abstention/failure; Local only skips unresolved items; Disabled runs no scoring for that source. Show these in a mode legend and the affected row, not one wall of prose. Scope checking stays advisory; completion reviews remain a separate system. Keep adoption gates and training data locality unchanged.

Existing `/models/llms/jev` stays valid and opens Try a decision. Add explicit `/models/llms/jev/:view` routes for `try`, `integrations`, `results`, `training`, and `setup`, ahead of the generic Models dispatcher. An invalid view replaces the URL with the `try` route. Register task destinations in the nav manifest without turning them into duplicate section-level entries. Do not overload the existing `recordId=jev` slot. Hold drafts, pending mutations, installed/runtime state, and the last score above the view body; switching views or using Back must not clear drafts, repeat scoring, or duplicate subscriptions. Reload restores the selected view; text drafts need not persist across a full reload or leaving the tool, but unsaved navigation must follow the existing guard policy. The earlier interactive concept is an illustrative ready-state, not live model output; its text-only navigation and mobile menu are superseded by the icon contract above.

## 8. Performance pilot specification

Default to **Results**, with **Capability tests**, **Agent checks**, and **Tuning** as sibling task views. A single “Run assessment” action opens the existing run-configuration flow. Batch scope belongs there; selecting the page must remain read-only.

- Results starts with the ranking intent and a compact comparable model table. Use one row per model/runtime/tuning measurement, clear missing/stale states, and selected evidence alongside it when space permits.
- Capability tests keeps its task filter and matrix but moves long test descriptions into test details. Keep all stored outputs reachable. Task recommendations include the evidence and limitations beside them.
- Agent checks owns PTY/harness benchmarks. Keep startup/paste overhead distinct from direct engine throughput.
- Tuning compares configurations for a selected model; throughput-by-context and timing details belong here or in the selected result, rather than after a long card stack.
- Show runtime availability compactly; expand only affected blockers and provide a named route to fix them. Do not repeat the same runtime warning in multiple large banners.
- Explain local-machine measurement scope once near the result context. Keep incomparable/stale results visible as such; no synthetic universal winner.

### Performance routes and state

Keep `/models/performance` as the Results landing. Add explicit `/models/performance/:view` routes for `results`, `capabilities`, `agent-checks`, and `tuning`; unknown views replace the URL with `results`. A selected measurement uses `/models/performance/results/:assessmentKey`, not the same segment as the view. Define `assessmentKey` as a reversible URL-safe encoding of the existing measurement identity tuple (backend, model ID, tuning key), with an explicit null/default tuning representation and parser tests; do not add a persisted ID or data migration just for navigation. Malformed/missing/deleted measurements show a recovery link to Results. Model IDs containing slashes and multiple tunings of one model must round-trip unambiguously.

Preserve existing measurement/sweep drawer search parameters (`measureBackend`, `measureModel`, `measureTuning`, and the existing sweep parameters) on legacy URLs and through view changes; retain the current one-drawer-at-a-time precedence. Keep the run owner and its event subscriptions above the active task view so navigation does not cancel/restart work, lose cancellation access, clear tuning drafts, or duplicate listeners. Back/forward and reload restore selection; server run state is reattached without implicitly starting a run. Use saved result identities and existing capability-detail URL contracts, rather than replacing them with component-only selection.

## 9. Shared patterns and implementation sequence

Reuse `PageHeader`, `TabPills`, `SectionTabsHeader`, `Drawer`, `FormField`, `Banner`, `Pill`, `OverflowMenu`, `PageSkeleton`, and existing asynchronous action/progress helpers. Consult the component and helper catalogs before creating anything.

Candidate additions after the two pilots prove the need: a section-navigation presentation for the existing manifest, a workspace layout with main/inspector slots, and common results-table framing. These are proposed responsibilities, not components that already exist. Do not build a universal schema-driven page engine or replace every component before delivering the first useful page.

1. Validate the reviewed navigation and page families through the pilot task study; earlier interactive examples remain exploratory and do not override the icon requirements.
2. Pilot Models navigation + Jev: preserve actions, URLs, validation, requests, and state semantics; compare desktop and narrow layouts.
3. Pilot Performance: results-first table, bounded run setup, task-specific evidence; retain all legacy measurements.
4. Extract only the patterns actually shared by those pilots; update component catalogs and client conventions with the accepted defaults.
5. Apply the same audit to Runtimes, CoS Tasks, Settings, Brain, and Apps; pick each page's primary task rather than copying the Jev layout.
6. Expand to remaining pages in small reviewable changes. Avoid a global CSS rewrite that changes every mature screen at once.

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

## Implementation tracking

[Epic #7791](https://github.com/atomantic/PortOS/issues/7791) owns the bounded first rollout. Merging this specification does not complete the epic or its implementation tasks. Each task waits for the specification PR to merge; later prerequisites are sequencing choices so pilots inform the next surface, not claims that all work is technically coupled.

| Task | Prerequisites after specification merge | Status/evidence |
| --- | --- | --- |
| [#7792 — Models navigation and icons](https://github.com/atomantic/PortOS/issues/7792) | None | Shipped in merged PR #7808 |
| [#7793 — Jev task views](https://github.com/atomantic/PortOS/issues/7793) | Models navigation | Shipped in merged PR #7839; synthetic responsive evidence is in the audit |
| [#7794 — Performance results workspace](https://github.com/atomantic/PortOS/issues/7794) | Models navigation and Jev pilot | Shipped in merged PR #7841 |
| [#7795 — Runtimes operations roster](https://github.com/atomantic/PortOS/issues/7795) | Performance pilot | Shipped in merged PR #7851; [synthetic validation](validation/7795-runtimes-workspace.md) |
| [#7796 — CoS queue-first Tasks](https://github.com/atomantic/PortOS/issues/7796) | Performance pilot | Shipped in merged PR #7850 |
| [#7797 — Settings, Brain and Apps follow-up audit](https://github.com/atomantic/PortOS/issues/7797) | Runtimes and CoS pilot outcomes | Audit shipped with [#7858](https://github.com/atomantic/PortOS/issues/7858), [#7859](https://github.com/atomantic/PortOS/issues/7859), and [#7860](https://github.com/atomantic/PortOS/issues/7860) as implementation slices |

Runtimes and CoS can proceed independently once their shared prerequisite is complete. The final audit files evidence-backed follow-ups; it does not silently expand this epic into an implementation promise for every page. Check live issue state and remove `blocked` only when the listed prerequisites have been met.

## Sources and rationale

The page families, spacing, navigation grouping, and pilot choices are PortOS design proposals based on the [repository/live audit](UX_DESIGN_AUDIT.md), not externally mandated rules.

- [NN/g: Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) supports moving secondary detail behind explicit requests while keeping primary work clear. Disclosure does not justify hiding sibling destinations.
- [W3C: Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) explains narrow-width/zoom reflow and the exception for two-dimensional tables within their own scroll region.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies the accessibility baseline, including contrast, focus, keyboard access, labels, and target-size requirements. The 44px touch target above is a PortOS design default, not a claim that every WCAG AA target must be 44px.
