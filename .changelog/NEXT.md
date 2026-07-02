# Unreleased Changes

## Delete confirmations

- **Destructive actions now show a clear "Delete? / Cancel" prompt instead of a hidden second click.** Deleting a round, universe, series, share bucket, issue/episode, or a Writers Room work/folder — and removing an Ask conversation or deleting a world in the Universe Builder — used to silently re-arm the same button on the first click, with nothing on screen telling you a second click was needed. Each of these now pops an explicit inline confirm/cancel affordance right where you clicked, so it's obvious what will happen and easy to back out. The pipeline's "replace existing scenes / pages / audio lines" extract buttons got the same treatment (an inline "Replace? / Cancel" row) instead of arming via a fleeting toast. Delete/confirm controls in the Writers Room library were also enlarged to a comfortable 44px touch target for mobile.

## Internal

- Migration 155 heals `data/prompts/stages/cd-treatment.md` installs that #1808's anchor-based migration 148 left stranded (#2042). Installs seeded before the `imageStrength` scene knob (older pre-#1808 template) got the `## Cast & ingredients` list but missed the per-scene `"cast": [{ "ingredientId": … }]` field, so the Creative Director cast-threading regression test stayed red on the runtime template and migration 148 (already applied) never re-ran. The new hash-driven prompt-replace upgrades those copies (and both pristine pre-#1808 shipped versions) to the current shipped reference, leaving hand-customized copies untouched. Also folds `cd-treatment.md` into `buildPromptDriftTables` so setup-data.js's drift warning classifies a stranded copy correctly.
