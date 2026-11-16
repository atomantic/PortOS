/**
 * Heal cd-treatment.md installs that #1808's migration 148 left stranded (#2042).
 *
 * Migration 148 backfilled the catalog-cast surfacing into `data/prompts/stages/cd-treatment.md` with two ANCHOR-based inserts: the `## Cast & ingredients` list section and the per-scene `"cast": [{ "ingredientId": … }]` field (anchored on the scene example's `"imageStrength": null` line). An install seeded BEFORE the `imageStrength` knob (the older pre-#1808 template, md5 `2ffa482e…`) lacks that anchor, so 148 applied insertion 1 but silently skipped 2, leaving md5 `95b76856…` without the per-scene `cast` field that `data.reference/prompts/stages/cd-treatment.md` ships;
 * 148 is already recorded in `data/migrations.applied.json`, so it never re-runs and the `creativeDirectorPrompts.test.js` cast-threading regression stays red on the runtime template.
 * This finishes the job with the canonical hash-driven prompt-replace (`./_lib.js`): a copy matching a KNOWN machine-produced shape (either pristine pre-#1808 version, or the 148-partial strand) is replaced wholesale with the current shipped reference; a hand-customized copy is left untouched with a warning, as in every prompt-replace migration. Idempotent. Exporting ACCEPTED_OLD_MD5 / NEW_SHIPPED_MD5 also folds cd-treatment.md into `buildPromptDriftTables`, so setup-data.js's drift warning classifies a stranded copy as auto-updatable (148 tracked it via anchors, invisible to the sweep).
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'cd-treatment.md': [
    '2ffa482e7bfb6fe8b7224505fedbf712', // pre-#1808 shipped, pre-imageStrength-knob (447d2b5e3 / 22a0aced0)
    '16d0ef6a7fd2533719a846019122ebee', // pre-#1808 shipped, post-imageStrength-knob (c68f38d09 / f04e3955c)
    '95b7685690ecfee4f682b0293b790277', // migration-148 partial: cast list inserted, per-scene cast field missed (the #2042 strand)
    // Shipped v2.24–v2.26, and migration 148's complete output for the
    // 16d0ef6a… body above: upgrades from v2.8–v2.26 reached this migration on
    // it and were falsely reported as customized before 371 upgraded them.
    'd940eadfb406ce584f0e244032f33382',
  ],
};

export const NEW_SHIPPED_MD5 = {
  'cd-treatment.md': '16c5ce4a199d8efbf80016424315beb6', // current shipped reference; migration 371 upgrades existing installs
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
