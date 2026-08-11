/**
 * Make render identity part of the pre-arc character foundation.
 *
 * The character architect previously completed the psychological engine while
 * its response contract omitted physicalDescription and every visual-design
 * field. Graphic-novel series could therefore settle their plots around a cast
 * whose bodies, silhouettes, and palettes were still blank. The judge now
 * treats that as an incomplete character foundation and the repair stage owns
 * those fields. Hash replacement preserves customized prompts and is
 * idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-character-foundation.md': [
    'd6c449c06de73a0868141c899b26e52c',
    '04419e382f3b46ed92bfaaa1d4f39e13', // this migration's own body, superseded by 256
  ],
  'pipeline-judge-foundation.md': [
    'edf7850d0c724c63761bc9fb667227d9',
    '02a8e9215ba534b333f3a29f11f3ac4f', // this migration's own body, superseded by 256
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-character-foundation.md': 'b7d2bac347e11171606f4c6acfcd32e1', // post-256 (series-linked cast)
  'pipeline-judge-foundation.md': 'e44b6c50d741bbd21fc86f481684c410', // post-256 (series-linked cast)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'character visual foundation',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the render-identity foundation contract.`,
});

export { applyMigration };
export default { up };
