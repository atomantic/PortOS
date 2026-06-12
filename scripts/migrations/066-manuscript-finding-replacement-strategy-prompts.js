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
  // 'cec8…' is this migration's own (post-066) completeness body, kept as
  // accepted-old because migration 083 (with-edits replace field) is the current
  // shape, so a copy still at the post-066 body is auto-upgradable.
  'pipeline-manuscript-completeness.md': ['1ee5ac936fbf1d365e0eaea99bcf1e77', 'cec8faeb75dfff74e41b8221145c2e92'],
  // 'c88a56…' is 060's multi-edit output; '88199bf…' is this migration's own
  // (post-066) fix body, kept as accepted-old because migration 084 (schematic
  // example placeholders) is the current shape, so a copy still at the post-066
  // body is auto-upgradable.
  'pipeline-manuscript-fix.md': ['c88a56304eb5e290ae0de9dadd20b310', '88199bf7b5b50155bd2e1624bd920ebd'],
};

// Post-change shipped hashes. Mirror these into every earlier migration that
// tracks the same file (056/057 for completeness, 060 for fix) so their
// drift-catch tests stay green. The completeness hash reflects the post-083 body
// (migration 083 added the with-edits `replace` field); the fix hash reflects
// the post-084 body (migration 084 made the JSON example schematic).
export const NEW_SHIPPED_MD5 = {
  'pipeline-manuscript-completeness.md': 'fd26f928c33803c12878a1bfb8561ece',
  'pipeline-manuscript-fix.md': 'e2baaf0f2f53c8aa1e934a428c0ca583',
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
