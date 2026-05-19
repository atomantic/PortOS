/**
 * Extend the idea / beat-sheet expansion prompt's `{{#series.characters}}`
 * iteration to surface `role`, `physicalDescription`, `personality`, and
 * `background` — matching the prose / comic-script / teleplay templates.
 *
 * Why:
 *   The character bible carries rich per-character context
 *   (`physicalDescription`, `personality`, `background`, `role`, etc.) but the
 *   first stage of the pipeline — idea / beat-sheet expansion — was rendering
 *   only `**{{name}}** — {{description}}`. Downstream stages (prose,
 *   comic-script, teleplay) already inject the richer fields with the same
 *   mustache pattern. The beat sheet is the spine every later stage hangs
 *   from, so letting the LLM see character interiority + role here produces
 *   better arc decisions that downstream stages can keep building on.
 *
 *   See PLAN.md `[pipeline-idea-stage-character-detail-plumbing]`.
 *
 * Implementation: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Hashes the file may have on disk pre-migration. Most recent shipped first,
// then older. Any match is "unmodified by user → safe to replace."
// Exported so the test suite can import them and detect drift without
// maintaining local copies.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md': [
    '1ee44cf95851ff8debf18729ebcd40b4', // post-004 shipped — current pre-025
    '41facefbc0c0549d456bef9111f95ab9', // post-003, pre-004, still in setup-data.js OLD list
    'aee25112b2c596f643b17c559b772c22', // pre-003, still in setup-data.js OLD list
  ],
};

// New shipped hash — what data.sample carries post-migration.
export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': '1f3c5d077a5ef9a4b610335d5e3edd9c',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'idea-stage-character-detail',
  customizedHint: (filename) =>
    `   To pick up the new {{#series.characters}} role/physicalDescription/personality/background\n` +
    `   plumbing manually, diff:\n` +
    `     data.sample/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and replace the character iteration block with the new shape.`,
  skipFooter: (count) =>
    `⚠️  ${count} idea-stage prompt could not be auto-updated because it was customized.\n` +
    `   The idea / beat-sheet expansion will keep working but won't see character\n` +
    `   \`role\`, \`physicalDescription\`, \`personality\`, or \`background\` from the bible.\n` +
    `   See data.sample/prompts/stages/pipeline-idea-expansion.md.`,
});

export { applyMigration };
export default { up };
