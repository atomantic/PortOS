/**
 * CWQE Phase 12 — cross-issue prose continuity (#2177).
 *
 * `pipeline-prose.md` gained a "Continuity with neighboring issues" block that
 * conditionally renders the previous issue's closing prose tail
 * (`{{#priorIssueProseTail}}`) and the next issue's opening beats
 * (`{{#nextIssueBeats}}`), gated by `{{#hasNeighborContinuity}}` — so chapter
 * boundaries flow and the narrative voice carries across issues.
 *
 * `scripts/setup-data.js` only copies *missing* prompt files, so existing
 * installs keep their old `pipeline-prose.md` until this migration rewrites it.
 * `pipeline-prose.md` already has a migration lineage (003/027/054/127/166) —
 * per the drift-cross-sync convention those earlier migrations were resynced in
 * this same change: the previous current hash moved into their `ACCEPTED_OLD_MD5`
 * and their `NEW_SHIPPED_MD5` bumped to the post-168 hash, so their drift-catch
 * tests stay in lock-step with the live sample. The drift baseline in
 * `setup-data-drift.test.js` was updated to match the merged sweep.
 *
 * Customization-safe: only installs whose copy still hashes to the prior shipped
 * version are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash (the current shipped body before #2177 — post-166).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-prose.md': ['430d38ed2da59e0d4212e65edc499a74'],
};

// Post-change shipped hash (neighbor-continuity block added).
export const NEW_SHIPPED_MD5 = {
  'pipeline-prose.md': '4cb3ef48309f3673570cf80e4d544b54',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'cross-issue prose continuity',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the "Continuity with neighboring issues" block (the\n` +
    `   {{#hasNeighborContinuity}} / {{#priorIssueProseTail}} / {{#nextIssueBeats}}\n` +
    `   sections).`,
  skipFooter: (count) =>
    `⚠️  ${count} prose prompt(s) could not be auto-updated because they were\n` +
    `   customized. Prose generation still works, but drafts will miss the\n` +
    `   cross-issue continuity context (previous issue's closing prose + next\n` +
    `   issue's opening beats) until you merge it from\n` +
    `   data.reference/prompts/stages/pipeline-prose.md.`,
});

export { applyMigration };
export default { up };
