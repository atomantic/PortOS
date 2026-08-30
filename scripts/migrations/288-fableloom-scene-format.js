/**
 * FableLoom scene formats — a loom is written either as narrated prose or as a
 * teleplay, and the generative stages now render that choice into their
 * prompts (`{{sceneFormatContract}}` / `{{narrationFormatContract}}`) instead
 * of hard-coding "100–250 words of second-person present-tense narration".
 *
 * `scripts/setup-data.js` only copies *missing* prompt files, so an install
 * that already has the v1 FableLoom templates (seeded by migration 286) would
 * keep them — and the format variables would render as literal `{{…}}` text
 * in every weave/branch/play prompt. This rewrites the three templates when
 * they still hash to the shipped v1 body; a customized template is left alone
 * and warned about.
 *
 * The weave template is resynced here when a later migration evolves it. Its
 * former current hash remains accepted so an install whose migration ledger is
 * replayed can still advance through this lineage before the latest sample.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hashes — the v1 bodies seeded by migration 286.
export const ACCEPTED_OLD_MD5 = {
  'fableloom-weave-episode.md': [
    '1fea11b8c4269008561ac22a30494d46',
    '18a442e39b973e4074a0d595928a665d', // post-311 / pre-319
  ],
  'fableloom-branch-node.md': ['f558e4804b056a5961af1ea74fdef2ba'],
  'fableloom-play-turn.md': ['bb33dc9bc483668d88196ca972d5f364'],
};

// Post-change shipped hashes (format contract rendered from the loom record).
export const NEW_SHIPPED_MD5 = {
  'fableloom-weave-episode.md': 'b4d363db94fd8a9928fa977745c76ff9', // post-321 outline expansion contract
  'fableloom-branch-node.md': '39a208c8cc593d0531af50760e3cf0da',
  'fableloom-play-turn.md': 'e35ad91aae263e3adf28d1e047a46661',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom scene format',
  customizedHint: (filename) =>
    `   To take the scene-format variable manually, diff:\n`
    + `     data.reference/prompts/stages/${filename}\n`
    + `   against your current:\n`
    + `     data/prompts/stages/${filename}\n`
    + `   and move the hard-coded prose rule to {{sceneFormatContract}}\n`
    + `   (or {{narrationFormatContract}}, in the play-turn template).`,
  skipFooter: (count) =>
    `⚠️  ${count} FableLoom prompt(s) could not be auto-updated because they were customized.\n`
    + `   Those looms still generate in narrated prose regardless of the story's\n`
    + `   format setting until you merge the variable from data.reference/.`,
});

export { applyMigration };
export default { up };
