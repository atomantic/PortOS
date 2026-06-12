/**
 * Let the manuscript-fix prompt return multiple issue-scoped edits.
 *
 * The original prompt only allowed one `{ find, replace }` pair. Broad
 * editorial findings often ask for two small insertions (or are unanchored at
 * the comment level but still actionable inside the manuscript), so the fix
 * pass now returns `{ edits: [{ issueNumber, find, replace }] }`.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash (single-edit fix prompt), plus the intermediate
// shipped bodies as accepted-old — 060's own multi-edit output ('c88a56…') and
// 066's replacementStrategy output ('88199bf…'). Later migrations further
// updated this file, so a copy still at any of these bodies is auto-upgradable
// to the current shape.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-manuscript-fix.md': ['196625952f4a36f3cb962c729f60f0ee', 'c88a56304eb5e290ae0de9dadd20b310', '88199bf7b5b50155bd2e1624bd920ebd'],
};

// Current shipped hash — migration 084 (schematic example placeholders) is the
// latest to touch this file, so this hash reflects the post-084 body. The
// idempotent-rerun and drift-catch tests require it to match the live
// data.reference body, not 060's own output.
export const NEW_SHIPPED_MD5 = {
  'pipeline-manuscript-fix.md': 'e2baaf0f2f53c8aa1e934a428c0ca583',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'manuscript-fix multi-edit prompt',
  customizedHint: (filename) =>
    `   To add multi-edit fixes manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and update the output contract to return edits[].`,
  skipFooter: (count) =>
    `⚠️  ${count} manuscript-fix prompt(s) could not be auto-updated because\n` +
    `   they were customized. Single-edit fixes still work, but broad or\n` +
    `   multi-location comments may not generate complete fix proposals until\n` +
    `   you merge the prompt change.\n` +
    `   See data.reference/prompts/stages/pipeline-manuscript-fix.md.`,
});

export { applyMigration };
export default { up };
