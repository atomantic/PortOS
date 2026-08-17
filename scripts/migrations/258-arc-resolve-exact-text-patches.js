/**
 * Keep arc verification repairs local inside long prose fields.
 *
 * A finding against one sentence in an 8,000-character volume synopsis used to
 * require returning the whole synopsis. That gave each repair thousands of
 * unrelated words of blast radius and could exceed the persistence limit. The
 * new prompt emits bounded, exact-match replacements for long arc/volume text.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-arc-resolve.md': ['31eca76b68f40de1b93734fe9bc9f4bb'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-arc-resolve.md': '638b988c84b3e5599f7a2ce09fa149ce',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'arc-resolve exact text patches',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the exact-text-v1 patch contract.`,
});

export { applyMigration };
export default { up };
