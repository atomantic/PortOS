/**
 * CWQE Phase 10 (remainder) — character framework generation doctrine (#2175).
 *
 * `universe-character-expand.md` gained the Ghost → Wound → Lie → Want → Need
 * chain (with interlock checks), the declared arc type, the Three Sliders
 * (proactivity/likability/competence 1–10), and a secrets list — so the
 * character-generation LLM elicits these authored fields up front, which the
 * `arc.*` / `character.consistency` editorial checks then reconcile against
 * (plan vs delivery) instead of inferring both.
 *
 * `scripts/setup-data.js` only copies *missing* prompt files, so existing
 * installs keep their old template until this migration rewrites it. This is a
 * NEW migration slot that OWNS the current shipped hash going forward; migration
 * 027 (the prior owner of universe-character-expand.md) is resynced in this same
 * change per the drift-cross-sync convention: its previous current hash moved
 * into `ACCEPTED_OLD_MD5` and its `NEW_SHIPPED_MD5` was bumped to the post-171
 * hash so its drift-catch test stays in lock-step with the live sample. The
 * drift baseline in `setup-data-drift.test.js` was updated to match.
 *
 * Customization-safe: only installs whose copy still hashes to the prior shipped
 * version are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash (the current shipped body before #2175 remainder).
export const ACCEPTED_OLD_MD5 = {
  'universe-character-expand.md': ['67b6e73ed47f318451a730088b4cff14'], // post-027
};

// Post-change shipped hash (character framework fields added).
export const NEW_SHIPPED_MD5 = {
  'universe-character-expand.md': '177b6e4e8bdf445308cf8ac423cd5ad8',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'character framework doctrine',
  customizedHint: (filename) =>
    `   To add the Ghost→Wound→Lie→Want→Need chain + arc type + Three Sliders +\n` +
    `   secrets manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the "Character framework" guidance + output-contract keys.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   Character generation still works, but the character-framework fields\n` +
    `   (ghost/wound/lie/want/need, arcType, sliders, secrets) will not be\n` +
    `   elicited until you merge them from data.reference/prompts/stages/.`,
});

export { applyMigration };
export default { up };
