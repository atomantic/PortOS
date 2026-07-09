/**
 * CWQE Phase 10 (remainder) — MICE thread nesting in the arc overview (#2175).
 *
 * `pipeline-arc-overview.md` gained a lean "Thread nesting (MICE)" instruction:
 * treat each season as opening/closing a narrative thread (Milieu / Inquiry /
 * Character / Event question); threads close in the REVERSE order they open
 * (nested brackets), and each season names the thread it opens and the thread
 * it closes so the nesting is legible to later structure checks.
 *
 * `scripts/setup-data.js` only copies *missing* prompt files, so existing
 * installs keep their old template until this migration rewrites it. This is a
 * NEW migration slot that OWNS the current shipped hash going forward; migration
 * 166 (the prior owner of pipeline-arc-overview.md) is resynced in this same
 * change per the drift-cross-sync convention: its previous current hash moved
 * into `ACCEPTED_OLD_MD5` and its `NEW_SHIPPED_MD5` was bumped to the post-173
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
  'pipeline-arc-overview.md': ['612f8b04950e2ff26dd350dd76a062fe'], // post-166 (foreshadowing ledger)
};

// Post-change shipped hash (MICE thread-nesting instruction added).
export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md': '74d6c26548660d85fc345b2099c63b6c',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'MICE thread nesting',
  customizedHint: (filename) =>
    `   To add the MICE thread-nesting instruction manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the "Thread nesting (MICE)" step into "How to shape the arc".`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   Arc planning still works, but the MICE thread-nesting doctrine will not\n` +
    `   be applied at generation until you merge it from\n` +
    `   data.reference/prompts/stages/.`,
});

export { applyMigration };
export default { up };
