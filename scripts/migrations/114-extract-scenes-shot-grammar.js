/**
 * Update the `pipeline-extract-scenes` stage prompt to emit shot-grammar fields
 * (#1315): each shot now carries `shotType` (camera framing) and `screenDirection`
 * (on-screen left/right/neutral), the two signals the deterministic
 * `visual.shot-continuity` editorial check reasons over (180°-rule axis reversals,
 * shot-type monotony).
 *
 * `scripts/setup-data.js` only COPIES missing prompt files — an existing install
 * already has `data/prompts/stages/pipeline-extract-scenes.md`, so it would keep
 * the old template (no `shotType`/`screenDirection` instruction) and the extractor
 * would never populate the new fields. This migration hash-replaces the installed
 * prompt with the new shipped version when it still matches the pre-change shipped
 * hash; a customized copy is left alone with a merge hint.
 *
 * Hash-driven prompt-replace via `./_lib.js` (newline-normalized MD5, so the
 * comparison is correct on Windows checkouts). Idempotent. Exporting
 * ACCEPTED_OLD_MD5 / NEW_SHIPPED_MD5 keeps the drift table in setup-data.js in
 * sync automatically (buildPromptDriftTables reads them).
 *
 * No stage-config change: `pipeline-extract-scenes` is already a shipped stage,
 * so only its prompt body moved.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-extract-scenes.md': [
    'c51fb208568d0d903eb43b437478b0ba', // pre-114 (pre shot-grammar fields)
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-extract-scenes.md': '9f404b0c4721b23932a6d2dcfc1fba43', // post-114 (shotType + screenDirection)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'pipeline scene-extract prompt',
  customizedHint: (filename) =>
    `   To add the shot-grammar fields manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the shotType + screenDirection shot fields (the field spec + the output-contract example).`,
  skipFooter: (count) =>
    `⚠️  ${count} scene-extract prompt(s) could not be auto-updated because they were customized.\n` +
    `   Scene extraction still works, but extracted shots won't carry shotType / screenDirection\n` +
    `   (and the visual.shot-continuity editorial check has nothing to read) until you merge the\n` +
    `   new shot fields. See data.reference/prompts/stages/pipeline-extract-scenes.md.`,
});

export { applyMigration };
export default { up };
