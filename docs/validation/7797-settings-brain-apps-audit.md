# Settings, Brain and Apps audit validation (#7797)

This record captures the bounded follow-up audit named by [#7797](https://github.com/atomantic/PortOS/issues/7797), after the Runtimes and CoS pilots. It is evidence for page-family assignment and implementation planning, not a claim that these six surfaces have already been redesigned.

## Evidence boundary

- The source and test references below are from the current checkout.
- Fixtures and examples are synthetic. No live instance records, saved settings, provider state, or machine identifiers are part of this record.
- Existing rendered tests establish interaction contracts and selected geometry assertions. This audit did not run a new production browser study or claim complete visual, accessibility, or performance certification for these six surfaces.
- The viewport matrix is the required validation for the follow-up implementation issues. It keeps the evidence boundary explicit instead of turning source review into an unsupported screenshot claim.

## Existing evidence inventory

| Surface | Current evidence | What it proves | What remains |
| --- | --- | --- | --- |
| Settings General | `client/src/components/settings/GeneralTab.test.jsx` | Save-backed settings appear before the instant theme picker; load fallback remains guarded; independent dirty baselines and failed timezone/location saves stay guarded. | Validate the proposed Configuration composition and responsive form grouping at the matrix widths. |
| Settings Backup | `client/src/components/settings/BackupTab.test.jsx` | Destination saves, restore dry-run/confirmation, integrity/schema failures, saved-state Run Now gates, degraded status, and resolved schedules have explicit contracts. | Validate status/action priority, sticky action-bar geometry, and keyboard/error visibility. |
| Brain Threads | `client/src/components/brain/tabs/ThreadsTab.test.jsx`, `client/src/pages/Brain.test.jsx` | Status/tag/search filters and selected thread are URL-backed; drawer selection, in-place completion, race handling, and icon navigation are covered. | Add an unavailable/retry state that cannot be mistaken for “Nothing tracked yet,” then validate the collection at narrow widths. |
| Brain Notes | `client/src/components/brain/tabs/NotesTab.test.jsx`, `client/src/pages/Brain.test.jsx` | Touch targets, force-save escalation, request lifetimes, stale selection protection, and Brain icon navigation are covered. | Add URL-backed vault/note selection and truthful vault/scan/read/delete failures without weakening force-save or draft behavior. |
| Apps list | `client/src/pages/Apps.test.jsx` | Row action hierarchy, Manage routing, archive query state, lifecycle feedback, operation banners, wrapping paths, and sprint-ticket failure/retry behavior are covered. | Keep the collection row-first, route deep diagnostics to detail, and distinguish unavailable from genuinely empty. |
| App detail | `client/src/components/apps/AppDetailView.test.jsx`, `client/src/pages/Apps.test.jsx` | Detail route lifecycle handling, old/current request races, feature-tab visibility, direct disabled-feature URLs, unique tab icons, and identity/action placement are covered. | Distinguish a failed detail request from a confirmed missing app and validate detail tab/Drawer geometry across widths. |

## Surface contracts

The audit assigns each surface the following primary job and compatibility boundary:

| Surface | Page family | Primary tasks | Must remain true |
| --- | --- | --- | --- |
| Settings General | Configuration | Set timezone; set or clear location; choose theme. | `/settings/general`, legacy redirects, independent saves, dirty indicators, and unsaved-change protection remain intact. |
| Settings Backup | Operations + Configuration | Inspect health; configure schedule/destination/excludes; run or restore. | `/settings/backup`, saved-state Run Now gates, dry-run restore, explicit confirmation, and failure visibility remain intact. |
| Brain Threads | Collection | Capture; filter/triage; edit or complete a selected thread. | `/brain/threads`, URL filters/selection, full-bleed scroll ownership, drawer drafts, and browser Back remain intact. |
| Brain Notes | Document or canvas | Switch vault/folder; search/open; edit/create/delete/save. | `/brain/notes`, force-save, editor/list pane ownership, and request-lifetime protection remain intact while selection becomes shareable. |
| Apps list | Collection | Inspect health; operate; open Manage/archive. | `/apps`, `?view=archived`, operation banners, lifecycle actions, overflow confirmation, and normal Layout scrolling remain intact. |
| App detail | Operations + Workbench | Identify status; run lifecycle/build/launch; inspect task/Git/quality/configuration. | `/apps/:id/:tab`, aliases, `TabPills mobileCompact`, unique icons, feature-gated direct routes, and edit-drawer query state remain intact. |

## Required viewport and interaction matrix

The following checks belong to the implementation slices linked from the audit. They use synthetic records such as `Example App`, `Example Thread`, and `Example Note` only.

| Viewport | Required checks |
| --- | --- |
| 1,920×1,080 | Title, current state, primary action, and the beginning of useful work are visible without a reference wall; Settings status/save actions and Apps identity/actions do not stretch into unrelated empty space. |
| 1,440×900 | Desktop hierarchy remains clear; Settings forms, Brain list/detail, and Apps collection/detail have one deliberate primary workspace surface; no duplicate full-height scroll owner appears. |
| 1,024×768 | Secondary details disclose or route on demand; action groups wrap without clipping; selected Brain/App state remains visible while the supporting pane is still usable. |
| 390×844 | `TabPills mobileCompact` keeps direct icon navigation and accessible names; forms and lifecycle actions remain reachable; full-bleed list/detail panes do not create page-level horizontal overflow. |
| 320px wide | Long paths, validation/errors, drawer content, and action labels wrap or scroll inside their owning region; no essential control is hidden behind an inaccessible overflow. |

Across each width, test light and dark themes, keyboard focus, copied canonical links, browser Back/forward, loading, real empty, unavailable, partial/stale, save failure, running, cancellation, and completion. Confirm that navigation itself makes no provider call and that dependent actions remain gated by saved state.

## Observed gaps and chosen follow-ups

1. **Settings General and Backup** — `GeneralTab` and `BackupTab` have valuable persistence and recovery contracts, but the audit needs a task-first composition and responsive evidence. Implement in [#7858](https://github.com/atomantic/PortOS/issues/7858).
2. **Brain Threads and Notes** — Threads list failure currently lands on empty copy, and Notes selection/error handling is not consistently shareable or truthful. Implement in [#7859](https://github.com/atomantic/PortOS/issues/7859). The follow-up also covers the observed note-delete failure path that can show success after a failed request.
3. **Apps list and detail** — the collection mixes deep diagnostics into rows, the list request failure looks empty, and detail failure looks missing. Implement in [#7860](https://github.com/atomantic/PortOS/issues/7860).

These are independently shippable slices. They preserve the adopted icon navigation, route contracts, optional-feature behavior, privacy boundary, explicit save/run/restore gates, and synthetic-only validation while narrowing each later change to a concrete surface.
