/**
 * pipeline-extract-scenes.md grew a per-scene `shots[]` decomposition so the
 * storyboard pipeline can render shot-level start frames + drive episode-video
 * clip grouping with continuity chaining. Existing installs need the updated
 * prompt to actually emit shots from the LLM.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-extract-scenes.md': [
    '59fa5ee305ce53d91eb15224d8b546d3', // pre-006 (original, no shots[])
    'c51fb208568d0d903eb43b437478b0ba', // post-006 / pre-114 — the hash this migration originally produced
  ],
};

// Tracks the LATEST shipped body. Bumped to the post-114 hash (shot-grammar
// fields) so this migration still upgrades a post-006/pre-114 install straight
// to current rather than classifying it "customized". The intermediate hash
// moved to ACCEPTED_OLD_MD5 above. See migration 114.
export const NEW_SHIPPED_MD5 = {
  'pipeline-extract-scenes.md': '9f404b0c4721b23932a6d2dcfc1fba43', // post-114 (shotType + screenDirection)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'extract-scenes shots',
  customizedHint: (filename) =>
    `   Manually merge the shots[] additions from:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   into your current:\n` +
    `     data/prompts/stages/${filename}`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated. Storyboard shot extraction\n` +
    `   will not produce shots[] until the prompt is updated manually.`,
});

export { applyMigration };
export default { up };
