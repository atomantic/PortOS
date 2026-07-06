/**
 * Update pipeline stage prompt templates that were updated in the
 * "length profile" feature (feat/pipeline-genconfig-length-cover).
 *
 * The prompts now carry `{{lengthTargets.*}}` variables so the idea, prose,
 * comic-script, and TV-script stages scale their beat counts, word targets,
 * and page/minute targets with the per-issue length profile picker instead of
 * using the old hardcoded numbers.
 *
 * `pipeline-tv-script.md` was renamed to `pipeline-teleplay.md` in 96bc7f17;
 * an older install that never ran migration 003 still carries the obsolete
 * file in `data/`. `retireOnSampleMissing: true` lets the shared helper soft-
 * delete it when unmodified and warn when customized, instead of crashing on
 * the sample-side ENOENT.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md': [ '93e9552c6662811e597a97296f3776a4',
    'aee25112b2c596f643b17c559b772c22', // pre-003 (original)
    '41facefbc0c0549d456bef9111f95ab9', // post-003 / pre-004 — the hash this migration originally produced
    '1ee44cf95851ff8debf18729ebcd40b4', // post-004 / pre-025
    '1f3c5d077a5ef9a4b610335d5e3edd9c', // post-025 / pre-054
    'b5c47c94ffc74637983c95761ab0c66c', // post-054 / pre-054-fence
    '49a208628290543ba2607a5ed48fdc8c', // post-054-fence / pre-098
  ],
  'pipeline-prose.md': [ '84523d531eeafa60959c65c553b2563f',
    'bfea5aeeb471aae9749baee765b473a7', // pre-003 (original)
    '30ac30ec2b9d3e2a9eb869c181732cc6', // post-003 / pre-027 — the hash this migration originally produced
    'd1f8e3f1d214725b5aa67f309a81cd7d', // post-027 / pre-054
    'bef1bc2767b78f585f2bd89f3d615130', // post-054 / pre-054-fence
    '25e3d58c2741bd98acd5d08ba70d8a5e', // post-127 / pre-166 (scene markers)
    '430d38ed2da59e0d4212e65edc499a74', // post-166 / pre-168 (craft anti-patterns)
  ],
  'pipeline-comic-script.md': [ 'a4303016c34b65e4b0e641fe71252de3',
    '40e5fdc1a1e68a7419b7dad936366c1a', // pre-003 (original)
    'beab031951859ca13579cdb9c4dbe769', // post-003 / pre-013 — the hash this migration originally produced
    '1e0af305c27d0c80c4b482d2ebcb4a0d', // post-013 / pre-027
    '133d200d069c2e8173b7c129eea58f53', // post-027 / pre-054
    'e530fc76b89cedaef848ad7ec99c934c', // post-054 / pre-054-fence
    'dea7d497d1cb38e7574f236f4ff8e644', // post-054-fence / pre-063
    'e9ee70bf18888492edada6633cd9928a', // post-063 / pre-121
    '7c05ecde539f04c9fa91e87543057204', // pre-121 reference body
  ],
  'pipeline-tv-script.md':       ['3f6fecc25573ed054b47db392250034a'],
  'pipeline-season-episodes.md': [
    '6e349ad26bed8a0ccb042571f03f03eb', // pre-003 (original)
    'c4928e2a5f833358116b29d2d669888d', // post-003 / pre-005 — the hash this migration originally produced
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': 'd6fa86a435f978336661dcabca67258f', // post-127 (scene markers)
  'pipeline-prose.md':           '4cb3ef48309f3673570cf80e4d544b54', // post-168 (cross-issue continuity)
  'pipeline-comic-script.md':    '49af30c05f008b20f6998a0f113f7d87', // post-127 (scene markers)
  'pipeline-tv-script.md':       '376f779f4687b598f1c92ca4e770fd5a', // retired upstream (no data.reference)
  'pipeline-season-episodes.md': '50c68a29c3ebc275db3095d06bd87100', // post-005
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'pipeline stage prompt',
  retireOnSampleMissing: true,
  customizedHint: (filename) =>
    `   To apply the length-profile variables manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the {{lengthTargets.*}} template variables.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   The length profile picker UI will work, but those prompts won't use\n` +
    `   {{lengthTargets.*}} variables until you merge them manually.\n` +
    `   See data.reference/prompts/stages/ for the updated templates.`,
});

export { applyMigration };
export default { up };
