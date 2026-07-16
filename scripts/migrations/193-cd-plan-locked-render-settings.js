/**
 * Update the `cd-plan` stage prompt to document the project's LOCKED render
 * settings (aspect ratio / dimensions / quality / target duration).
 *
 * Background: the Creative Director planner authors `media_enqueueVideoJob`
 * steps freehand. It historically guessed an `aspectRatio` string the video
 * worker doesn't even read (`generateVideo` consumes `width`/`height`, not
 * `aspectRatio`), so a commission locked to 9:16 rendered at the worker's
 * default 768×512 box. The server now forces the locked geometry onto every
 * render (server/services/creative/tools/media.js#enforceVideoRenderPreset);
 * this prompt change tells the planner to stop supplying those params so the
 * plan preview stays honest and the LLM doesn't fight the enforcement.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent — only an
 * install still carrying the pre-change shipped template is auto-updated; a
 * customized copy is left alone with a merge hint.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'cd-plan.md': ['3ce871196a8fd04781b71b6780e89c86'], // pre-193 shipped
};

export const NEW_SHIPPED_MD5 = {
  'cd-plan.md': '0768d6809645c2c1fe73cacae9740fe9', // post-193 (locked render settings)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'creative-director stage prompt',
  customizedHint: (filename) =>
    `   To apply the locked-render-settings note manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the "## Locked render settings" section.`,
  skipFooter: (count) =>
    `⚠️  ${count} cd-plan prompt(s) could not be auto-updated because they were customized.\n` +
    `   Video renders still get the locked aspect ratio (the server enforces it),\n` +
    `   but the planner won't see the note until you merge it manually.`,
});

export { applyMigration };
export default { up };
