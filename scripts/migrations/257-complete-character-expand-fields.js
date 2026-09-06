/**
 * Let the visible "AI: expand character" action finish the whole bible card.
 *
 * The old response/merge contract excluded physical description, personality,
 * background, and wardrobes, so a successful expansion could still leave the
 * card visibly incomplete. Hash replacement preserves customized prompts.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'universe-character-expand.md': ['177b6e4e8bdf445308cf8ac423cd5ad8'],
};

export const NEW_SHIPPED_MD5 = {
  'universe-character-expand.md': '961b73ba6e50df5d49f0cc76505e50bd',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'complete character expansion fields',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add physical description, personality, background, and wardrobes.`,
});

export { applyMigration };
export default { up };
