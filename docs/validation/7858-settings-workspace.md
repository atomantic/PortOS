# Settings General and Backup workspace validation (#7858)

This record validates the task-first composition shipped for the Settings General and Backup tabs. It uses synthetic settings, paths, backup statuses, and snapshot identifiers only. It is not a live-instance report and does not claim a complete visual or accessibility certification.

## Content maps

| Surface | Page family | Before | After | Preserved boundary |
| --- | --- | --- | --- | --- |
| General | Configuration | Timezone, location, and immediate theme were three equal stacked cards. | Timezone and location form the recurring saved-configuration grid; theme follows as a secondary immediate preference. | `/settings/general`, legacy redirects, independent saves, dirty indicators, route guard, and theme behavior. |
| Backup | Operations + Configuration | Status, schedule, exclusions, snapshots, restore, and actions formed one long sequence. | Health and saved schedule lead; destination/schedule and saved-state actions follow; exclusions and snapshot history are named disclosures. | `/settings/backup`, resolved schedules, saved-state Run Now gate, degraded status, restore dry-run/confirmation, and failure states. |

## Observed rendered-test evidence

The focused client run was:

```text
./node_modules/.bin/vitest run src/components/settings/GeneralTab.test.jsx src/components/settings/BackupTab.test.jsx src/pages/Settings.tabs.test.jsx
```

Observed result: 3 test files and 57 tests passed.

- General still renders independent timezone and location saves, reports validation/request failures inline, keeps each group dirty after a failed save, and preserves the unsaved-navigation guard.
- Backup still renders resolved schedule values, keeps Run Backup Now disabled for an unsaved or missing destination, preserves the degraded database status, and keeps the dry-run-before-confirmation restore boundary.
- Snapshot history is collapsed by default behind a named disclosure with `aria-expanded`; opening it exposes synthetic snapshots and the existing restore actions.
- The content order places the health/status and saved schedule summary before the action bar, and the action bar before the exclusions and snapshot details.
- General and Backup retain container-scoped single-column defaults with a two-column layout at the 52rem container threshold; narrow inputs, paths, errors, and action rows use wrapping or break-word/break-all styles.

## Required matrix and evidence status

| Width | Observed in this record | Hypothesis / remaining check |
| --- | --- | --- |
| 1,920px | Responsive layout classes and task order are present in the rendered component contract. | Browser geometry should confirm the two-column grouping uses space without creating a reference wall. |
| 1,440px | Responsive layout classes and task order are present in the rendered component contract. | Browser geometry should confirm the action bar and status remain above useful work. |
| 1,024px | Responsive layout classes provide the wide grouping once the component container reaches 52rem. | Browser geometry should confirm the available Settings content width crosses the intended threshold without clipping. |
| 390px | Single-column default, wrapped controls, minimum touch targets, and break-word/break-all text classes are present. | Browser and keyboard pass should confirm focus order, sticky-bar behavior, and no page-level horizontal overflow. |
| 320px | Single-column default, wrapped controls, minimum touch targets, and break-word/break-all text classes are present. | Browser and keyboard pass should confirm long synthetic paths, validation errors, and restore actions remain reachable. |

## Compatibility checklist

- Existing Settings navigation, routes, redirects, feature gates, and icon presentation are unchanged.
- General save baselines remain independent; a failed save does not falsely clear dirty state.
- Backup schedule values remain server-resolved; editing exclusions does not replace them with client defaults.
- Run Now continues to use saved settings and refuses unsaved drafts.
- Restore continues to dry-run first, then requires explicit confirmation before the destructive request.
- Degraded backup status remains visible and actionable rather than becoming an empty-state interpretation.

The remaining browser geometry and complete accessibility checks are intentionally listed as hypotheses rather than reported as observed facts.
