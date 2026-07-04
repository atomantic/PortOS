/**
 * Heal cd-treatment.md installs that #1808's migration 148 left stranded (#2042).
 *
 * Migration 148 backfilled the catalog-cast surfacing into
 * `data/prompts/stages/cd-treatment.md` with two ANCHOR-based surgical inserts:
 *   1. the `## Cast & ingredients` list section (anchored on the style-spec →
 *      user-story bracket), and
 *   2. the per-scene `"cast": [{ "ingredientId": … }]` JSON field (anchored on
 *      the scene example's `"imageStrength": null` line).
 *
 * An install seeded BEFORE the `imageStrength` scene knob shipped (the older
 * pre-#1808 template, md5 `2ffa482e…`) carries a scene example that lacks that
 * anchor, so 148 applied insertion 1 (the file gained the cast list) but silently
 * skipped insertion 2 — leaving the file at md5 `95b76856…`: it has the Cast
 * section but is missing the per-scene `cast` field that
 * `data.reference/prompts/stages/cd-treatment.md` ships. Because 148 is already
 * recorded in `data/migrations.applied.json` on those installs, it never re-runs,
 * so the `creativeDirectorPrompts.test.js` cast-threading regression stays red on
 * the runtime template forever.
 *
 * This migration finishes the job with the canonical hash-driven prompt-replace
 * (`./_lib.js`): when the installed copy still matches a KNOWN machine-produced
 * shape (either pristine pre-#1808 shipped version, or the 148-partial strand) it
 * is replaced wholesale with the current shipped reference. A hand-customized
 * copy (hash matches neither old nor new) is left untouched with a warning — same
 * safety contract as every other prompt-replace migration. Idempotent.
 *
 * Exporting ACCEPTED_OLD_MD5 / NEW_SHIPPED_MD5 also folds cd-treatment.md into
 * `buildPromptDriftTables`, so setup-data.js's drift warning classifies a
 * stranded copy as auto-updatable (was previously invisible to the sweep because
 * 148 tracked the file via anchors, not hashes).
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'cd-treatment.md': [
    '2ffa482e7bfb6fe8b7224505fedbf712', // pre-#1808 shipped, pre-imageStrength-knob (447d2b5e3 / 22a0aced0)
    '16d0ef6a7fd2533719a846019122ebee', // pre-#1808 shipped, post-imageStrength-knob (c68f38d09 / f04e3955c)
    '95b7685690ecfee4f682b0293b790277', // migration-148 partial: cast list inserted, per-scene cast field missed (the #2042 strand)
  ],
};

export const NEW_SHIPPED_MD5 = {
  'cd-treatment.md': 'd940eadfb406ce584f0e244032f33382', // #1808 shipped reference (cast list + per-scene cast field)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'cd-treatment catalog-cast strand',
  customizedHint: (filename) =>
    `   To apply the per-scene cast field manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the gated "cast": [{ "ingredientId": … }] field after the\n` +
    `   scene example's "imageStrength" line.`,
  skipFooter: (count) =>
    `⚠️  ${count} cd-treatment prompt(s) could not be auto-updated because\n` +
    `   they were customized. Creative Director treatments still generate, but\n` +
    `   per-scene cast threading may stay underspecified until you merge the\n` +
    `   prompt change manually.\n` +
    `   See data.reference/prompts/stages/cd-treatment.md.`,
});

export { applyMigration };
export default { up };
