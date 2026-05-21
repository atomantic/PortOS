/**
 * Augment `pipeline-idea-expansion.md` with arc / volume / neighbor-issue
 * context blocks. The beat-sheet expander now sees the whole-series arc, the
 * parent volume's logline / synopsis / endingHook, the immediately-prior
 * issue's beats (or synopsis when un-expanded), and the immediately-next
 * issue's beats / synopsis — same shape a human editor has open while
 * writing beats.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md': [
    '1ee44cf95851ff8debf18729ebcd40b4', // post-004 / pre-025 — the hash this migration originally produced
    '41facefbc0c0549d456bef9111f95ab9', // post-003 / pre-004
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': '1f3c5d077a5ef9a4b610335d5e3edd9c', // post-025
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'idea-expansion context',
  customizedHint: (filename) =>
    `   To pick up the new arc / volume / neighbor-issue context blocks, diff:\n` +
    `     data.sample/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the {{#arc}}, {{#volume}}, {{#priorIssue}}, {{#nextIssue}},\n` +
    `   {{#priorVolume}}, {{#arcRole}}, and {{#positionInVolume}} sections.`,
});

export { applyMigration };
export default { up };
