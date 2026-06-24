/**
 * Carry the canonical-scene-list instruction into the TV teleplay stage prompt
 * so the teleplay inherits the beat sheet's `## Scenes` numbers + sluglines
 * verbatim — the same instruction `pipeline-prose.md` already carries (added in
 * migration 127). With this, "Scene 2" is the same Scene 2 across the beat
 * sheet, prose, comic script, and teleplay, so storyboards/video extracted from
 * any of them share one scene id space.
 *
 * One prompt changes:
 *   - `pipeline-teleplay.md` gains a "Honor the canonical scene list" rule:
 *     when the source material includes a `## Scenes` list, number the
 *     `### Scene N` headers to match and copy each `INT./EXT. LOCATION — TIME`
 *     slugline verbatim; only derive boundaries when no list is provided.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent. Existing
 * installs that already applied the earlier teleplay prompt migrations sit on
 * the prior shipped hash below; this migration carries them forward to the
 * canonical-scene-list version. (The earlier migrations in this file's lineage —
 * 027 and 054 — were resynced to the same new hash so their drift-catch tests
 * keep passing.)
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-teleplay.md': ['afa4215330bf856429d70d7e2f856605'], // post-054-fence
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-teleplay.md': '2ea9974ac3803658b2314db1f5818b77', // post-128 (canonical scene list)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'teleplay canonical scene-list prompt',
  customizedHint: (filename) =>
    `   To add the canonical scene-list instruction manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the "Honor the canonical scene list" rule (reuse the beat\n` +
    `   sheet's "## Scenes" numbers + sluglines verbatim instead of\n` +
    `   inventing scene boundaries).`,
  skipFooter: (count) =>
    `⚠️  ${count} teleplay prompt(s) could not be auto-updated because they\n` +
    `   were customized. The pipeline still generates teleplays, but they may\n` +
    `   not reuse the beat sheet's canonical scene numbers/sluglines — so\n` +
    `   teleplay-extracted storyboards can drift from comic-page scene numbers\n` +
    `   until you merge the prompt change manually.\n` +
    `   See data.reference/prompts/stages/pipeline-teleplay.md.`,
});

export { applyMigration };
export default { up };
