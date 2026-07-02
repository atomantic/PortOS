# Unreleased Changes

## Delete confirmations

- **Destructive actions now show a clear "Delete? / Cancel" prompt instead of a hidden second click.** Deleting a round, universe, series, share bucket, issue/episode, or a Writers Room work/folder — and removing an Ask conversation or deleting a world in the Universe Builder — used to silently re-arm the same button on the first click, with nothing on screen telling you a second click was needed. Each of these now pops an explicit inline confirm/cancel affordance right where you clicked, so it's obvious what will happen and easy to back out. The pipeline's "replace existing scenes / pages / audio lines" extract buttons got the same treatment (an inline "Replace? / Cancel" row) instead of arming via a fleeting toast. Delete/confirm controls in the Writers Room library were also enlarged to a comfortable 44px touch target for mobile.

## Accessibility

- **Config form labels now focus their field when clicked and read correctly to screen readers.** Many settings/config forms (AI Providers, DataDog, feature-agent config, message & calendar account setup, scheduled-task provider/model pickers, the agent world/schedule tabs, MeatSpace nicotine + POST drills, and more) rendered the label as a plain sibling of its input with no association, so clicking the label did nothing and assistive tech couldn't announce the pairing. These fields now flow through a shared `FormField` wrapper that generates a stable id and wires `htmlFor`/`id` automatically, keeping the exact same styling (#2027). Remaining forms are tracked for a follow-up sweep (#2051).

## Loading states

- **The DataDog, Jira, and GitHub integration pages now show a layout-shaped skeleton on first paint instead of a centered "Loading…" line.** Each page previously rendered a bare full-screen text message sized with `h-screen`, which mis-sized under mobile browser chrome and jumped when the real content arrived. They now share a `PageSkeleton` that reserves the header + card-grid dimensions (matching the loaded layout, using the `port-*` design tokens like the dashboard's `WidgetSkeleton`), so there's no post-load layout jump and no full-height wrapper fighting Layout's scroll (#2029).

## Internal

- Consolidated five component-local duration/uptime/time-until formatters onto the shared `utils/formatters.js` helpers (`formatDurationMs`, `timeUntil`), per the "do not re-define formatters inside components" convention (#2028). `formatDurationMs` gained a day bucket (`2d 3h`) so long uptimes no longer render as an unbounded hours count; ProcessesTab, CityHud, Shell session ages, the CoS QuickSummary "next job" countdown, and the Loops interval label now all route through the shared helpers, and a `console.log` in `memoryClassifier.js` was collapsed to a single interpolated line.
- Migration 155 heals `data/prompts/stages/cd-treatment.md` installs that #1808's anchor-based migration 148 left stranded (#2042). Installs seeded before the `imageStrength` scene knob (older pre-#1808 template) got the `## Cast & ingredients` list but missed the per-scene `"cast": [{ "ingredientId": … }]` field, so the Creative Director cast-threading regression test stayed red on the runtime template and migration 148 (already applied) never re-ran. The new hash-driven prompt-replace upgrades those copies (and both pristine pre-#1808 shipped versions) to the current shipped reference, leaving hand-customized copies untouched. Also folds `cd-treatment.md` into `buildPromptDriftTables` so setup-data.js's drift warning classifies a stranded copy correctly.
