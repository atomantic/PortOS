# Unreleased Changes

## Internal

- Migration 155 heals `data/prompts/stages/cd-treatment.md` installs that #1808's anchor-based migration 148 left stranded (#2042). Installs seeded before the `imageStrength` scene knob (older pre-#1808 template) got the `## Cast & ingredients` list but missed the per-scene `"cast": [{ "ingredientId": … }]` field, so the Creative Director cast-threading regression test stayed red on the runtime template and migration 148 (already applied) never re-ran. The new hash-driven prompt-replace upgrades those copies (and both pristine pre-#1808 shipped versions) to the current shipped reference, leaving hand-customized copies untouched. Also folds `cd-treatment.md` into `buildPromptDriftTables` so setup-data.js's drift warning classifies a stranded copy correctly.
