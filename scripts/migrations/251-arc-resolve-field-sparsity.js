/**
 * Keep arc auto-resolve patches sparse at the field level and teach the prompt
 * the persisted arc/volume string budgets. This prevents a targeted synopsis
 * correction from needlessly rewriting a valid logline and prevents the store
 * sanitizer from clipping an oversized LLM field mid-sentence.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['8bb134554c122d1583c479ab3010e53d'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '638b988c84b3e5599f7a2ce09fa149ce', // post-274 planning economy
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve field-sparse bounded patches',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add field-level sparsity plus the persisted string limits.`,
});

export { applyMigration };
export default { up };
