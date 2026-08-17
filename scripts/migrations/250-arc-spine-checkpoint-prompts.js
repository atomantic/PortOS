/**
 * Make arc generation honor the recommended volume count and make arc
 * verification safe to run before episode seeding. The verifier also receives
 * the protected starter idea explicitly so an internally coherent replacement
 * premise cannot pass the new pre-episode checkpoint.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-overview.md': ['648e11352cd1565aee490de1f662bef0'],
  'pipeline-arc-verify.md': [
    '36aa70cdfc25d7549573a4d556e7702c',
    '83347e7d923580a3062033ab39b3c14b', // post-250 / pre-261
    '68f6956d7e09ebdb3870d8726b1b2a7a', // post-261 / pre-263 — before the world category canon block
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-overview.md': '5ed760caaf3cf88916ec28b220e2f590',
  'pipeline-arc-verify.md': 'a397f158fd9c0dca1c8dbe62df253f70', // post-274 planning economy
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'pre-episode arc spine checkpoint',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add series-scoped canon plus the pre-episode spine contract.`,
});

export { applyMigration };
export default { up };
