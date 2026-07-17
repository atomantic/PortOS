# Unreleased Changes

## Internal

- **[issue-2706] Stage-seeding migrations now guard their own `data.reference` assets.** Migrations 189 (model-personality), 094 (object-attachment checks), and 182 (CWQE quality) each seed stage prompts on upgrade but shipped without a colocated test, so a rename or removal of a reference template would have surfaced only at runtime as "Stage not found" on a fresh install. Each now has a `.test.js` asserting it seeds when absent, no-ops on re-run, never clobbers a customized template or hand-tuned config entry, and — the point — that every `data.reference/prompts/stages/*.md` template it names and its `stage-config.json` entry actually ship. The three suites collapse to one `runSeedStageMigrationTests({ migration, stages, prefix })` call apiece via a new shared helper — the seed-family analogue of `_testHelpers.js`'s `runPromptMigrationTests`. (`scripts/migrations/_seedStageTestHelpers.js`)

## Fixed

- [issue-2669] Sharing, Messages, and Calendar screens no longer show two stacked error toasts when a share/subscribe/export/save/sync action fails — the custom-catch callers now pass `{ silent: true }` so only their own toast fires, not the shared `request()` helper's default one too. Swept the Messages/calendar/sharing feature area (both ConfigTabs, InboxTab, ReviewTab, ShareToButton, and the Sharing page) and threaded a backward-compatible `options` arg into the affected API wrappers (`evaluateMessages`, `enableGmailApi`, `getGoogleAuthUrl`, `create/updateMessageAccount`, `create/updateCalendarAccount`, `updateSubcalendars`, `saveGoogleAuthCredentials`, `start/runGoogleAutoConfig`, `confirmDailyReviewEvent`).
- Creative Director projects that use the Antigravity provider no longer get stuck on "Planning." The agent now reliably receives its instructions instead of launching and sitting idle at an empty prompt (it waits for Antigravity's input box to be ready before sending, the same way the Claude provider does), so planning actually runs to completion.
- A Creative Director project no longer wedges in "Planning" when its agent is interrupted or crashes mid-run. The stuck run is now cleaned up as soon as the dead agent is detected, so the project can retry on its own instead of waiting for the next server restart.
- The Creative Director "Runs" tab now shows why a run failed (e.g. "interrupted by restart") instead of leaving failed runs blank with no explanation.
- Creative Director agents are no longer told to run `/do:push` (or open a pull request) when they finish. A CD agent's job is to write its plan or update a scene over the API, not to change code — so the end-of-task "commit and push" instruction was wrong and just made the agent load that command for nothing. They now get a completion step that matches what they actually do.

## Character Sheet

- `[issue-2673]` **Your Character level is now your age.** The Character's level is reframed as life experience — `level = floor(age in years)`, derived on read from your canonical birth date instead of being ground out of XP thresholds (JIRA tickets + CoS tasks). XP survives as a cumulative stat but no longer drives level, and the CyberCity HUD badge now shows the age-based level with a progress bar toward your next birthday (a friendly "set birth date" prompt when no birth date is set yet). Existing character records keep loading unchanged, and the derived level is excluded from cross-machine sync so peers never fight over a stale value.

## Creative Commissions

### Changed

- [issue-2686] Creative Commissions now federate across your machines as a split record: the **brief** (name, intent, genre, generation settings) and your **taste feedback** (👍/👎 + notes) sync to your other peers, while each machine keeps its own **schedule** and **run history** — so the same commission and its accumulated taste appear everywhere, but only the machine you scheduled it on fires the cron (no double-run). A reaction rated on one machine steers that commission's next run on another. Two new sync-category toggles appear under a peer — **Commissions** (the brief) and **Commission Feedback** (the reactions) — both PostgreSQL-backed with soft-delete tombstones so removals propagate instead of resurrecting. Feedback moved out of an inline field into its own `commissionFeedback` record kind (one row per reaction, capped per commission); existing inline reactions are split into the federated store automatically at boot.
