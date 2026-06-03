/**
 * Unify the finding-shape contract across the manuscript-completeness and
 * manuscript-fix prompts by making the `suggestion` field's meaning explicit.
 *
 * Background: the `comic-structure` category (migration 057) repurposed
 * `suggestion` as a COMPLETE panel-by-panel replacement document, while every
 * narrative category uses it as delta advice. Nothing in the contract declared
 * which one a given finding was — the fix step inferred it from the category.
 *
 * This migration ships a `replacementStrategy: 'delta' | 'full-page'` field on
 * each finding in both prompts:
 *   - completeness prompt: emit `replacementStrategy` in the output contract
 *     ('full-page' for comic-structure, 'delta' for everything else) so the
 *     overloaded use of `suggestion` is declared, not inferred.
 *   - fix prompt: branch on the strategy — substitute a full-page suggestion
 *     directly vs. synthesize an edit from delta advice.
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old templates until this migration rewrites them. Customization-
 * safe: only installs whose copy still hashes to a known prior shipped version
 * are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hashes: completeness from migration 057 (six-category
// comic-structure prompt), fix from migration 060 (multi-edit prompt).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-manuscript-completeness.md': ['1ee5ac936fbf1d365e0eaea99bcf1e77'],
  'pipeline-manuscript-fix.md': ['c88a56304eb5e290ae0de9dadd20b310'],
};

// Post-change shipped hashes (replacementStrategy contract on both prompts).
// Mirror these into every earlier migration that tracks the same file
// (056/057 for completeness, 060 for fix) so their drift-catch tests stay green.
export const NEW_SHIPPED_MD5 = {
  'pipeline-manuscript-completeness.md': 'cec8faeb75dfff74e41b8221145c2e92',
  'pipeline-manuscript-fix.md': '88199bf7b5b50155bd2e1624bd920ebd',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'manuscript finding replacementStrategy prompts',
  customizedHint: (filename) =>
    `   To add the replacementStrategy contract manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the replacementStrategy field (delta vs full-page) to the\n` +
    `   finding output contract / fix-reading instructions.`,
  skipFooter: (count) =>
    `⚠️  ${count} manuscript prompt(s) could not be auto-updated because they\n` +
    `   were customized. The editorial pass still works, but comic-structure\n` +
    `   findings won't be explicitly tagged as full-page replacements until\n` +
    `   you merge the change.\n` +
    `   See data.reference/prompts/stages/pipeline-manuscript-completeness.md\n` +
    `   and data.reference/prompts/stages/pipeline-manuscript-fix.md.`,
});

export { applyMigration };
export default { up };
