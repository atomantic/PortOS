/**
 * Teach the comic-script verifier to flag repeated confrontation loops.
 *
 * The script-craft pass already checks malformed structure, but repeated
 * beats across a long scene can still leave an issue looking like time is not
 * advancing. This migration updates the verifier prompt with an explicit
 * continuity-loop rule while preserving customized installed prompts.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-script-verify.md': [
    'ed6c8101644cfe56a100eb6bfe3587f3', // pre-122
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-script-verify.md': '722c62462d05462603cf67ca0ed1dee8', // post-122
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'script-verify continuity-loop prompt',
  customizedHint: (filename) =>
    `   To add the continuity-loop rule manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the rule telling the verifier to flag repeated confrontation\n` +
    `   beat cycles where time does not appear to advance.`,
  skipFooter: (count) =>
    `⚠️  ${count} script-verify prompt(s) could not be auto-updated because\n` +
    `   they were customized. Comic script verification still runs, but long\n` +
    `   repeated beat loops may remain under-detected until you merge the\n` +
    `   prompt change manually.\n` +
    `   See data.reference/prompts/stages/pipeline-script-verify.md.`,
});

export { applyMigration };
export default { up };
