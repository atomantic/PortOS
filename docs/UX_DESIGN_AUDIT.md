# Admin workspace UX audit

Date: 2026-09-21. Scope: a representative sample to establish reusable patterns, not a completed audit of every PortOS route. All examples in deliverables must be synthetic; no live record names, topology, saved settings, or measurement results are reproduced here.

## Evidence and limits

- Jev: user-supplied desktop screenshot, live navigation, and checkout component review.
- Performance: live 1,280px-wide browser screenshot/rendered content and checkout component review.
- Runtimes: live browser screenshot, checkout component review, and the synthetic validation record in [the Runtimes pilot](validation/7795-runtimes-workspace.md).
- CoS Tasks: live browser screenshot and checkout page/task component review.
- Settings General and Backup, and Brain Threads and Notes: current source and rendered-test review only; observations about their rendered behavior remain hypotheses to validate. The Apps list/detail slice now also has source and synthetic rendered-test evidence in [#7860](https://github.com/atomantic/PortOS/issues/7860), but its viewport behavior remains unverified.
- The live application displayed a client/server build mismatch. Its visual evidence and the current checkout are complementary snapshots; no runtime reconciliation or model actions were performed.
- These are heuristic findings. No user task timings, complete accessibility audit, or production responsive test pass has been performed.

## Findings and redesign map

| Surface and evidence | Current friction | Proposed pattern | What must survive |
| --- | --- | --- | --- |
| Models shell: `client/src/pages/Models.jsx`, `components/models/ModelsTabsHeader.jsx`, `components/settings/LocalLlmTab.jsx` | Fifteen peer tabs overflow; the LLM sub-row contains three independently useful destinations. Jev and Abuse Guard exist in the manifest but lack the same visible prominence. | A labeled section navigator exposes destinations together; local views belong to one task/tool. | Canonical paths, aliases, optional-feature gates, alphabetical order, palette and voice navigation. |
| Jev: `client/src/components/models/JevPanel.jsx:214`, `JevIntegrations.jsx:46` | A `max-w-6xl` outer panel leaves desktop space unused. Setup, policies, formulas, agreement, training, and scoring form one sequential document. Frequent work is below long explanations. | Five named views; scoring input and result side by side; compact status; setup stages in Setup; source policies in aligned rows. | Separate readiness/enablement states, abstention, exact modes, explicit scoring/training, local training data, adoption gates. |
| Performance: `client/src/components/settings/LocalModelAssessments.jsx:958` | Intro, runtime roster, agent checks, capability suite, sweep configuration, ranked cards, throughput, and tuning stack in one view. Results repeat across different presentations and arrive late. | Results-first analytics table and selection detail; separate capability, agent, and tuning tasks. | Measurement provenance, partial/stale data, distinct timing bases, saved output, run controls, no auto-run. |
| Runtimes: `client/src/components/settings/LocalLlmRuntimesView.jsx:716` | Service controls, installation, checkpoint discovery, default backend, and speculative tuning share a long page. Runtime rows have uneven density and control wrapping. | Operations roster with consistent identity/state/action columns; selected runtime configuration and named install/checkpoint workflow. | Independent services, process lifecycle truth, install progress, resource estimates, unavailable-platform states. |
| CoS: `client/src/pages/ChiefOfStaff.jsx:913`, `components/cos/tabs/TasksTab.jsx:214` | Desktop identity/avatar column reserves 320px; expanded task creation/settings appear before the queue. The live initial viewport emphasizes configuration and persona over task inspection. | Queue-first operations view; compact task composer, detailed execution settings on demand, collapsible persona retained as a preference. | Identity/personality, active progress, task creation defaults, review gates, sortable pending tasks, keyboard interactions. |
| Apps detail: `client/src/components/apps/AppDetailView.jsx:335` | Header combines identity and many lifecycle actions; density needs state-specific prioritization. Source already contains responsive title/edit grouping and a shared edit drawer. | Preserve these useful patterns; prioritize one contextual lifecycle action and move rare actions to the shared overflow pattern. | Edit next to identity, responsive behavior, status truth, app-specific controls and deep links. |
| Settings: `client/src/pages/Settings.jsx:61` | Same header + wide destination-strip shell as Models; large configuration domains compete for navigation. | Grouped section navigator, bounded form grids, per-task save feedback; retain feature-local settings drawers. | Existing redirects, save semantics, privacy/credential controls. |
| Brain: `client/src/pages/Brain.jsx:148` | Many fixed sections share a tab row; the shell must also accommodate both documents and full-bleed tools. | Test a grouped navigator; preserve distinct document and workbench layouts rather than one universal grid. | URL-backed selection, full-bleed scroll ownership, drafts, loading geometry, record privacy. |

Paths without a `client/src/` prefix in the evidence column are relative to it. Line numbers are audit anchors and may drift; component names and surrounding render blocks are the durable references.

## Why local fixes have not been enough

The application already has responsive grids, icon-prefixed navigation, reusable tabs, drawers, route-backed selections, and loading/error conventions. The missing layer is page composition: deciding which job the page serves and how to keep other jobs accessible without stacking every implementation concern into it. The existing CoS compact mobile icon row is a pattern to preserve across the rollout.

Removing a max-width alone would stretch Jev's prose and fields. Putting every existing block in cards would keep the competing tasks. Adding accordions alone would hide the problem and make discovery depend on opening each one. The proposal changes information placement first and then uses shared visual primitives.

## Pilot content inventory

Jev: identity/readiness → header; enablement/source modes → Integrations; scoring inputs and decision → Try a decision; agreement/counts → Results; head training and adoption → Training; runtime/install/checks/logs/unload → Setup; formula and definitions → named contextual help. Keep essential mode and abstention consequences visible.

Performance: intent/ranked comparison → Results; throughput report and per-context measurements → selected result/Tuning; capability matrix and saved outputs → Capability tests; PTY benchmark → Agent checks; sweep setup → run flow; availability → compact status with named recovery; methodology → help/detail. Do not discard unassessed or excluded models: represent their evidence state and recovery action.

## Rollout priorities

1. Models navigation + Jev validates discoverability, lifecycle configuration, and input/output layout.
2. Performance validates dense evidence, comparisons, filters, and explicit long-running actions.
3. Runtimes and CoS Tasks validate operations queues and configuration disclosure.
4. Settings, Brain, Apps, then remaining areas receive page-specific audits against the adopted guide.

Each slice needs a behavior inventory, a content map, responsive review, and a small task-based evaluation. The [design guide](UX_DESIGN_GUIDE.md) supplies the acceptance checklist and reusable brief.

## Second review and resolved findings

| Finding | Resolution in the specification |
| --- | --- |
| The first draft's mobile section sheet would replace icon navigation. | Require desktop icon prefixes and CoS-style mobile `TabPills mobileCompact` for section and task destinations. A grouped sheet is supplementary only. |
| A Models-only shell change would strand cross-prefix destinations. | Include `/ai/*`, Models-owned `/devtools/*` destinations, and Playground in navigation coverage and active-state acceptance. |
| Generic keyboard language did not protect icon-specific behavior. | Specify distinct icons, stable accessible names, non-color selection, focus visibility, scrolling into view, overflow controls, and touch targets. |
| New task views could collide with generic `recordId` routes or reset active work. | Specify explicit Jev/Performance route matrices, legacy defaults, invalid-route recovery, measurement identity, drawer compatibility, and state/subscription ownership. |

The review also confirmed missing Jev and Abuse Guard entries in `client/src/lib/navPresentation.js`; promotion must add distinct icon mappings. Navigation changes must preserve the shared registry, not copy icons into a second list. The earlier conversation mockup is exploratory; its text-only navigation and menu-only mobile shell do not override the reviewed icon requirements.

## Jev pilot (#7793)

The pilot retains the newer Decision Classifiers home introduced after the
specification: `/models/decision-classifiers/jev/:taskView`. The proposed
`/models/llms/jev/:taskView` links redirect there. Try a decision is the default;
unknown views recover to Try. Integrations, Results, Training and Setup are
named destinations with desktop labels and compact mobile icons. Mutable state
and subscriptions remain mounted across local view changes; hidden panels are
excluded from keyboard and accessibility navigation. No new draft store exists.

Synthetic, isolated-component Chromium checks compared the previous panel with
the pilot at 1920, 1440, 1024, 390 and 320px widths. The Score button's bottom
moved from approximately 1861 to 569 document pixels at desktop widths, and from
3211 to 677 at 320px. No page-level horizontal overflow appeared in those checks.
Input and decision evidence share columns at wide widths and stack on phones.
Browser Back retained the synthetic draft; switching to Integrations exposed
source controls. These are component geometry and interaction observations,
not human task timings or certification of the complete application shell.

Rendered regressions cover scoring success, abstention and failure; setup and
training gates; source-save failure; legacy host routing; invalid task recovery;
and a scoring result arriving while another task is selected without duplicate
subscriptions. The same explicit API actions and adoption criteria remain in
place. The pilot provides a composition example, not a new universal component.


### Runtimes operations pilot (#7795)

The roster now selects runtime configuration by URL, preserves form/progress owners across selection, and keeps setup guidance in a named disclosure. See [task map and synthetic validation evidence](validation/7795-runtimes-workspace.md) for observed layout, interaction checks, and evidence limits.

## Follow-up audit: Settings, Brain and Apps (#7797)

This is a bounded source-and-test audit after the Runtimes and CoS pilots. `Observed` means a behavior or composition was verified in the current checkout; `proposed` means a follow-up is required before the pattern is treated as shipped. The audit records page-family assignments and preserves existing route, icon, feature, privacy, and persistence contracts. It does not implement a universal layout or redesign these surfaces in place.

| Surface and evidence | Page family and three primary tasks | Before → after content map | Navigation, scroll, and state contract | Error boundary and follow-up |
| --- | --- | --- | --- | --- |
| Settings General — `client/src/pages/Settings.jsx`, `client/src/components/settings/GeneralTab.jsx` | Configuration. Set timezone; set or clear location; choose interface theme. | Three independent cards are already bounded by the Settings shell → group timezone and location as the recurring configuration work, with theme as a secondary preference that does not compete with save feedback. | `/settings/general` stays canonical, with the Settings icon from `NAV_PRESENTATION` and legacy tab redirects. The Settings content region owns the normal scroll. Independent saves, dirty indicators, and the unsaved-changes guard remain visible. | Load failure currently toasts and establishes empty baselines; field validation and save failure must keep the affected group dirty and actionable. Follow-up: [#7858](https://github.com/atomantic/PortOS/issues/7858). |
| Settings Backup — `client/src/pages/Settings.jsx`, `client/src/components/settings/BackupTab.jsx` | Operations + Configuration. Inspect backup health; configure schedule/destination/excludes; run or restore a backup. | A long form already contains status, schedule, disclosures, snapshots, and restore controls → put health and the next safe action first, with configuration and recovery detail disclosed below. | `/settings/backup` stays canonical with the Download icon. The Settings content region remains the primary scroll owner; the action bar may stay sticky without covering errors. Saved destination/schedule state, Run Now gating, dry-run restore, and destructive-action confirmation remain unchanged. | `loadFailed` already has an explicit unavailable panel; degraded database status, invalid restore input, and failed restore must remain distinct from an empty snapshot list. Follow-up: [#7858](https://github.com/atomantic/PortOS/issues/7858). |
| Brain Threads — `client/src/pages/Brain.jsx`, `client/src/components/brain/tabs/ThreadsTab.jsx` | Collection. Capture an open loop; triage by status/tag/search; edit, link, or complete a selected thread. | The collection and URL-backed drawer are an adopted pattern → retain the full-bleed collection, add an explicit unavailable/retry state, and keep the drawer as the selected record's task surface. | `/brain/threads` remains a direct icon destination using ListTodo and `TabPills mobileCompact`. Threads owns its full-bleed scroll. `status`, `tag`, `q`, `thread`, and `threadTab` remain URL-backed; drafts/save/delete and browser Back remain observable. | List failure currently falls through to the same empty copy as “Nothing tracked yet”; a failed refresh must preserve the distinction and offer retry. Follow-up: [#7859](https://github.com/atomantic/PortOS/issues/7859). |
| Brain Notes — `client/src/pages/Brain.jsx`, `client/src/components/brain/tabs/NotesTab.jsx` | Document or canvas. Switch vault/folder; search and open a note; edit, create, delete, and save. | A local split pane provides vault/list/editor work → retain independent editor and list scrolling while making vault/note selection URL-shareable and keeping the active note visible on narrow screens. | `/brain/notes` remains a direct FileText destination with `TabPills mobileCompact`. The full-bleed shell owns the workspace; list and editor panes keep their own scroll only because this is a genuine list/detail editor. Note drafts, force-save, and request-lifetime behavior remain. | Vault, scan, and read failures currently become empty or stale state; delete failure can also report success after a swallowed request. Follow-up: [#7859](https://github.com/atomantic/PortOS/issues/7859) captures the deep-link and truthful-state repair. |
| Apps list — `client/src/pages/Apps.jsx`, `client/src/lib/layoutRoutes.js` | Collection. Inspect health; start/stop/restart or launch; open Manage/archive. | Implemented in [#7860](https://github.com/atomantic/PortOS/issues/7860): rows keep identity, health, primary lifecycle actions, and Manage; repository, configuration, PM2, and board detail stay in the detail workspace. | `/apps` remains the collection route with archive state in `?view=archived`, existing operation banners, and normal Layout scrolling. Lifecycle feedback, overflow confirmation, and feature-aware action availability remain intact. | Collection failures now render an unavailable/retry state; a successful empty array remains `No apps registered`; a failed refresh keeps the last loaded rows visible with a stale warning. |
| App detail — `client/src/pages/AppDetail.jsx`, `client/src/components/apps/AppDetailView.jsx` | Operations + Workbench. Identify status and execute lifecycle/build/launch; inspect task, Git, quality, and configuration tabs. | Implemented in [#7860](https://github.com/atomantic/PortOS/issues/7860): the route-backed detail workspace owns deep work while preserving its header, contextual lifecycle action, edit drawer, and feature-gated tabs. | `/apps/:id/:tab` and its aliases remain shareable. `TabPills mobileCompact`, unique tab icons, full-width detail scrolling, and `?edit=1`/`appTab` drawer state remain. No provider work starts from navigation. | Non-404 detail failures now render a retryable unavailable state; a confirmed 404 remains “App not found” with recovery to Apps. |

### Apps follow-up verification (#7860)

The Apps slice is implemented in [#7860](https://github.com/atomantic/PortOS/issues/7860):

- `/apps` is collection-first: identity/health, primary lifecycle and launch controls, Manage, archive, and removal remain; repository/configuration/PM2/JIRA detail is reached through the detail workspace.
- Collection load failures are explicit and retryable, remain distinct from a successful empty collection, and preserve a previously loaded list with a stale warning when a refresh fails.
- `/apps/:id/:tab` keeps route, tab, feature, and drawer contracts; non-404 detail failures are retryable unavailable states and 404 is confirmed missing.
- Synthetic rendered coverage is in `client/src/pages/Apps.test.jsx` and `client/src/components/apps/AppDetailView.test.jsx`.

This verifies source and rendered-test contracts only; the 1,920/1,440/1,024/390/320 viewport matrix still requires browser validation and is not claimed here.

### Adopted lessons from the pilots

- Runtimes and CoS now demonstrate that selected work belongs in the URL and that local form/progress owners must survive sibling-view changes; the six surfaces above must preserve that contract where they already have it.
- Desktop destinations keep icon prefixes, and fixed mobile destinations keep their distinct `TabPills mobileCompact` icons and accessible names. A supplemental sheet cannot replace direct navigation.
- Empty, loading, unavailable, partial, stale, and confirmed-missing states are different evidence states. Threads and Notes remain concrete follow-up work; Apps list and detail now carry those distinctions explicitly.
- Saved-state gates and destructive recovery are behavior boundaries: Settings Backup must not run or restore against unresolved state, Brain edits must preserve drafts, and Apps lifecycle actions must report their actual operation state.

### Follow-up issue register

| Issue | Bounded slice | Current status |
| --- | --- | --- |
| [#7858](https://github.com/atomantic/PortOS/issues/7858) | Settings General and Backup composition, save/error evidence, and responsive validation. | Open; follows this audit. |
| [#7859](https://github.com/atomantic/PortOS/issues/7859) | Brain Notes deep links plus Threads/Notes unavailable and empty-state truthfulness. | Open; follows this audit. |
| [#7860](https://github.com/atomantic/PortOS/issues/7860) | Apps collection-first hierarchy plus truthful list/detail unavailable states. | Implemented; source/rendered tests updated; viewport matrix remains open. |

The [synthetic validation record](validation/7797-settings-brain-apps-audit.md) lists the existing test evidence, remaining viewport checks, and compatibility checklist. These follow-ups are deliberately implementation slices; #7797 is complete when the audit and evidence register are published, not when those later UI changes merge.
