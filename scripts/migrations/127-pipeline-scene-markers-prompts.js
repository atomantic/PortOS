/**
 * Introduce scene markers across the pipeline's text-stage prompts so a single
 * canonical scene list flows from the beat sheet down to the comic pages.
 *
 * Three prompts change:
 *   - `pipeline-idea-expansion.md` (beat sheet) gains a `## Scenes` section —
 *     the canonical numbered scene list (`Scene N — INT./EXT. LOCATION — TIME`)
 *     that every downstream adaptation inherits.
 *   - `pipeline-prose.md` is told to reuse the beat sheet's scene numbers +
 *     sluglines verbatim rather than re-deriving them.
 *   - `pipeline-comic-script.md` tags each page header `## Page N — Scene M:
 *     SLUGLINE`, so the comic-page parser can record per-page scene info and
 *     the render path can chain renders within a scene but break across one
 *     (don't reference the prior page across a scene cut).
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent. Existing
 * installs that already applied the earlier prompt migrations sit on the prior
 * shipped hashes below; this migration carries them forward to the scene-marker
 * versions. (The earlier migrations in this file's lineage were resynced to the
 * same new hashes so their drift-catch tests keep passing.)
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md': ['93e9552c6662811e597a97296f3776a4'], // post-124 (scope-discipline)
  'pipeline-prose.md': ['84523d531eeafa60959c65c553b2563f', '25e3d58c2741bd98acd5d08ba70d8a5e'], // post-054-fence; post-127/pre-164 (scene markers)
  'pipeline-comic-script.md': ['a4303016c34b65e4b0e641fe71252de3'], // post-126 (visible text exactness)
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': 'd6fa86a435f978336661dcabca67258f', // post-127 (scene markers)
  'pipeline-prose.md': '430d38ed2da59e0d4212e65edc499a74', // post-164 (craft anti-patterns)
  'pipeline-comic-script.md': '49af30c05f008b20f6998a0f113f7d87', // post-127 (scene markers)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'pipeline scene-marker prompts',
  customizedHint: (filename) =>
    `   To add scene markers manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the scene-list / scene-slug carrying changes (beat sheet's\n` +
    `   "## Scenes" section, prose reusing those sluglines, and the comic\n` +
    `   script's "## Page N — Scene M: SLUGLINE" page headers).`,
  skipFooter: (count) =>
    `⚠️  ${count} pipeline prompt(s) could not be auto-updated because they\n` +
    `   were customized. The pipeline still generates, but scene markers may\n` +
    `   be missing — so comic-page renders won't auto-chain within a scene\n` +
    `   or break across one until you merge the prompt changes manually.\n` +
    `   See data.reference/prompts/stages/pipeline-{idea-expansion,prose,comic-script}.md.`,
});

export { applyMigration };
export default { up };
