/**
 * Publish the character-arc field budgets to the arc-resolve prompt.
 *
 * The measured-budget block only ever covered the arc + volume prose, whose
 * caps run to 8,000 characters. A transition `label` gets 200 and is CLIPPED
 * rather than rejected when the resolver overruns it — so a milestone rewrite
 * landed as a half-clause ("...escrows the proceeds with no repayment lien,
 * no"), the next verification round reported the record as textually
 * incomplete, and the loop diverged. The prompt now names the whole-field
 * (not exact-text) contract for character arcs and receives their budgets.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['2349bce80e9df8caafa391a6106327b6'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '638b988c84b3e5599f7a2ce09fa149ce',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve character-arc budgets',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the character-arc field budget rules.`,
});

export { applyMigration };
export default { up };
