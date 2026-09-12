/**
 * Fully author every character minted by a series, including supporting cast.
 *
 * The previous character foundation selected only names visible in the current
 * synopsis/arc and did not own profile fields such as pronouns, age, likes,
 * mannerisms, or skills. A series-extracted supporting character could therefore
 * have a complete dramatic framework while their Universe Bible card remained
 * visibly unfinished. Hash replacement preserves customized prompts.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-character-foundation.md': ['04419e382f3b46ed92bfaaa1d4f39e13'],
  'pipeline-judge-foundation.md': ['02a8e9215ba534b333f3a29f11f3ac4f'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-character-foundation.md': 'c606061954b23a9957c68dd068b54dc4',
  'pipeline-judge-foundation.md': 'd4abf4ddafbf84a2903e6d70d14adea1',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'series-linked character profiles',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the complete series-linked profile contract.`,
});

export { applyMigration };
export default { up };
