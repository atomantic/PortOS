/**
 * Add anchored findings to the manuscript-completeness ("Finish the draft")
 * prompt.
 *
 * The prompt previously returned findings with only a fuzzy human `location`
 * string. It now also returns a structured `issueNumber` plus a verbatim
 * `anchorQuote` excerpt, so the manuscript editor can map a finding to its
 * issue section and jump to the exact spot the gap occurs. See
 * server/services/pipeline/arcPlanner.js (shapeCompletenessFindings).
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old template until this migration rewrites it. Customization-safe:
 * only installs whose copy still hashes to the known pre-change shipped version
 * are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash (location-only findings).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-manuscript-completeness.md': ['e6858c74ab2cead752d388e3f428406c'],
};

// Post-change shipped hash (issueNumber + anchorQuote anchored findings).
// Mirror this into setup-data.js's drift table.
export const NEW_SHIPPED_MD5 = {
  'pipeline-manuscript-completeness.md': '4f2b95778aed85f5fc461d71eb461b79',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'manuscript-completeness anchored-findings prompt',
  customizedHint: (filename) =>
    `   To add anchored findings manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the issueNumber + anchorQuote fields to the output contract.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were\n` +
    `   customized. "Finish the draft" still works, but its findings won't\n` +
    `   carry issueNumber/anchorQuote (so click-to-jump in the manuscript\n` +
    `   editor falls back to the fuzzy location text) until you merge the\n` +
    `   change. See data.reference/prompts/stages/pipeline-manuscript-completeness.md.`,
});

export { applyMigration };
export default { up };
