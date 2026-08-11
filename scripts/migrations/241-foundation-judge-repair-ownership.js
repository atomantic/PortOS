/**
 * Teach the foundation judge which persisted surface owns each repair.
 *
 * A judge could correctly spot a plot synopsis violating a clear world rule,
 * but label it worldbuilding and ask that repair to revise the episode. The
 * world editor can only update the universe bible, so the causal contradiction
 * survived every round. The ownership contract routes plot applications to
 * structure while keeping missing rules in worldbuilding. Hash replacement
 * preserves customized prompts and is idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-judge-foundation.md': [
    '74c0244e641dcf7a73e9c83123ebdee9',
    'edf7850d0c724c63761bc9fb667227d9', // superseded by 255 (visual foundation)
    '02a8e9215ba534b333f3a29f11f3ac4f', // superseded by 256 (series-linked cast)
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-judge-foundation.md': 'e44b6c50d741bbd21fc86f481684c410', // post-256 (series-linked cast)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'foundation judge repair ownership',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the repair ownership boundaries.`,
});

export { applyMigration };
export default { up };
