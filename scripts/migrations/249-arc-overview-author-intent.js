/**
 * Put the protected Universe Builder starter idea in the arc-generation prompt.
 *
 * The context builder already supplied worldStarter/worldPremise/worldStyleNotes,
 * but the shipped prompt rendered only the named canon inventory. That let an
 * internally coherent derived bible displace the user's originating story
 * engine before the expensive season plan was written. Hash replacement keeps
 * customized prompts intact and is idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-overview.md': ['74d6c26548660d85fc345b2099c63b6c'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md': '901557b9f146a2d279ce2e81bda24d73',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc overview protected author intent',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the protected starter-idea block.`,
});

export { applyMigration };
export default { up };
