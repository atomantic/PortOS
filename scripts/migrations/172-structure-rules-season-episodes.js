/**
 * CWQE Phase 10 (remainder) — structure rules at generation, season beats (#2175).
 *
 * `pipeline-season-episodes.md` gained a lean "Structure rules" block:
 *   - try-fail mandate (60%+ of middle episodes end "Yes, but" / "No, and")
 *   - beat rules (Catalyst external; Break Into Two is a protagonist choice;
 *     All Is Lost includes a death — literal or of a hope/relationship/identity)
 *   - climax = the protagonist's hardest ACTIVE choice between Want and Need
 *
 * `scripts/setup-data.js` only copies *missing* prompt files, so existing
 * installs keep their old template until this migration rewrites it. This is a
 * NEW migration slot that OWNS the current shipped hash going forward; migration
 * 003 (the prior owner of pipeline-season-episodes.md) is resynced in this same
 * change per the drift-cross-sync convention: its previous current hash moved
 * into `ACCEPTED_OLD_MD5` and its `NEW_SHIPPED_MD5` was bumped to the post-172
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
  'pipeline-season-episodes.md': ['50c68a29c3ebc275db3095d06bd87100'], // post-005 (via 003)
};

// Post-change shipped hash (structure rules block added).
export const NEW_SHIPPED_MD5 = {
  'pipeline-season-episodes.md': 'a88e8e78a949b7aaf500d03314e2ea0b',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'season-episode structure rules',
  customizedHint: (filename) =>
    `   To add the try-fail mandate + beat rules + active-climax guidance\n` +
    `   manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the "Structure rules" block under "How to shape the season".`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   Season planning still works, but the try-fail mandate + beat rules will\n` +
    `   not be enforced at generation until you merge them from\n` +
    `   data.reference/prompts/stages/.`,
});

export { applyMigration };
export default { up };
