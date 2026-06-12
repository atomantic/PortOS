/**
 * Add the optional `replace` (with-edits) field to the manuscript-completeness
 * ("Finish the draft") prompt.
 *
 * The editorial review can now run in a "generate edits for every finding" mode:
 * the same completeness pass returns, alongside each finding's advisory
 * `suggestion`, a concrete `replace` — the rewritten text that substitutes for
 * `anchorQuote` to close the gap. The manuscript editor seeds each comment's
 * `fix` from `{ find: anchorQuote, replace }`, so the user reviews the full diff
 * and accepts edits one-by-one without a per-comment "Generate fix" call.
 *
 * The new `replace` field + its rule live inside a `{{#withEdits}}` Mustache
 * section, so the findings-only pass renders the prompt exactly as before — only
 * the with-edits pass sees the additional instruction. See
 * server/services/pipeline/arcPlanner.js (shapeCompletenessFindings) and
 * manuscriptReview.js (seedReviewFromFindings).
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old template until this migration rewrites it. Customization-safe:
 * only installs whose copy still hashes to the known pre-change shipped version
 * are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash: the post-066 (replacementStrategy) completeness body.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-manuscript-completeness.md': ['cec8faeb75dfff74e41b8221145c2e92'],
};

// Post-change shipped hash (with-edits `replace` field). Mirror this into every
// earlier migration that tracks the same file (056/057/066) so their drift-catch
// tests stay green.
export const NEW_SHIPPED_MD5 = {
  'pipeline-manuscript-completeness.md': 'fd26f928c33803c12878a1bfb8561ece',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'manuscript-completeness with-edits replace prompt',
  customizedHint: (filename) =>
    `   To add the with-edits replace field manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the {{#withEdits}} replace field to the output contract + rules.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were\n` +
    `   customized. Editorial review still works, but the "generate edits for\n` +
    `   every finding" option won't pre-build fixes (the per-comment\n` +
    `   "Generate fix" button still works) until you merge the change.\n` +
    `   See data.reference/prompts/stages/pipeline-manuscript-completeness.md.`,
});

export { applyMigration };
export default { up };
