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
  'pipeline-extract-scenes.md': ['59fa5ee305ce53d91eb15224d8b546d3'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-extract-scenes.md': 'c51fb208568d0d903eb43b437478b0ba',
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
