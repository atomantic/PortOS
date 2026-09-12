/**
 * Give exact arc repairs measured room instead of asking the model to count an
 * entire long field. Also makes the no-truncation contract explicit: a patch
 * whose delta exceeds the remaining characters is rejected, not clipped.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['17fbb066d7957dc2e345df1795bb0d9d'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '56926d795bd31f7e05e6bbbc646ecf9f',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve measured text budgets',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the measured exact-text budget block.`,
});

export { applyMigration };
export default { up };
