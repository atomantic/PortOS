# Narrow-container layout audit

## Scope and findings

Pattern inventory: 1,705 tracked non-test client JS/JSX sources, including 131 page sources. Searched for fixed/minimum widths, custom grid tracks, non-wrapping action rows, and viewport layout variants in every registered dashboard widget. This is a source-pattern audit plus the browser sample below, not visual certification of all route/state combinations.

| Surface | Failure pattern | Change |
| --- | --- | --- |
| GitHub Repos | Fixed side rail and desktop toolbar active inside a narrow page; filter and repository action rows overflow | Named page/card containers, delayed rail, wrapping filters/actions, shrinkable search and long secret names |
| Jira, DataDog | Same fixed rail; header actions exceed narrow content width | Container-based rail and wrapping headers |
| Create App, LoRA dataset, Story Builder | Fixed rail activated by viewport despite sidebar-reduced content width | Stack until the page container fits both columns; shrinkable main track |
| Brain Inbox and import preview | Fixed review/settings rail uses viewport width | Named container tracks and matching placement/sticky variants |
| PageSkeleton | Loading side rail can activate earlier than the loaded page fits | Container-based sidebar layout |
| Apps Grid, Hourly Activity | Desktop column counts remain active in a small dashboard tile | Clamped auto-fit app grid and container-based heatmap |
| System Health, CoS, Backup, Goals, Upcoming Tasks, Network Exposure, Decision Log, While Away | Viewport-based padding, summary columns or labels inside resizable tiles | Component-owned containers; narrow padding; container variants |
| System Health, Backup, Upcoming Tasks, Network Exposure | Browser measurements additionally exposed overflowing header/actions/metadata/status | Wrapping groups and bounded status values |

## Browser evidence

Used an isolated Vite harness importing the real components and stylesheet, with API responses intercepted to synthetic fixtures. No live instance records or provider calls were used. Chromium checked each visible descendant's rectangle against the fixture bounds and compared scrollWidth/clientWidth (1px rounding tolerance).

- GitHub, Jira, DataDog, Apps Grid (six apps), and Hourly Activity (24 nonzero hours): 240, 320, 390, 640, 768, 960 and 1200px fixture widths inside a 1440px desktop viewport; no remaining measured overflow.
- GitHub additionally exercised populated repositories, long names/URLs and long secret names at those container widths and at 320, 390, 768, 1024, 1280 and 1440px viewport widths; no remaining measured overflow.
- System Health, CoS, Backup, Goals (one active goal), Upcoming Tasks (ready task), Network Exposure, Decision Log and While Away: 240, 320, 480 and 960px fixture widths; no remaining measured overflow. Backup used its never-run state; Decision Log used aggregate counts without decision rows; While Away used empty activity.
- The supplementary page/Brain/skeleton changes were source-reviewed and covered by existing applicable tests/build, not individually certified by this browser sample. Full navigation-shell, every theme, zoom, loading/error and every record state remain the scheduled audit's responsibility.

## Prevention and checks

`client/src/dashboardWidgetContainerConventions.test.js` discovers widget entrypoints from the registry and rejects viewport-based layout variants with explicit exceptions for device-specific behavior. Existing responsive-grid checks remain in place. `docs/UX_DESIGN_GUIDE.md` defines container sizing, wrapping, long strings, local scrolling, viewport/sidebar/zoom/state acceptance and honest coverage reporting.

The UX scheduled-task default now includes responsive layout as checklist item 8, a six-viewport matrix, narrow desktop widgets, clipping checks, sidebar/zoom/state checks and cross-audit deduplication. Version 3 retires version 2's hash so existing uncustomized schedules upgrade through the normal store path; customized prompts remain user-owned.

Focused client validation passed 126 tests across 10 suites; prompt compatibility/integrity validation passed 91 tests across two suites. StoryBuilder's existing tests emitted a reproduced localhost request error despite passing; tracked separately in [#8064](https://github.com/atomantic/PortOS/issues/8064).

Rebase reconciliation: PR #8063 independently shipped widget container conversions and a stronger registry guard while this audit was running. Preserve its header sizing and column thresholds, reuse that guard instead of duplicating it, and retain this audit's shrink/wrap fixes and page/prompt/design changes.
