/**
 * Make the pipeline text-stage prompts source-agnostic.
 *
 * Previously each template hardcoded one upstream source slot:
 *   - pipeline-prose          → {{stages.idea.content}}   (beat sheet only)
 *   - pipeline-comic-script   → {{stages.prose.content}}  (prose only)
 *   - pipeline-teleplay       → {{stages.prose.content}}  (prose only)
 *   - pipeline-idea-expansion → {{seed}} only
 *
 * They now render a generic `{{#sourceMaterials}}` block so any stage can be
 * generated FROM any other populated stage (backport: prose from a comic
 * script, beat sheet back-filled from finished prose, etc.). See
 * server/services/pipeline/textStages.js (buildStageContext → sourceMaterials).
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old templates until this migration rewrites them. Customization-
 * safe: only installs whose copy still hashes to a known pre-change shipped
 * version are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hashes (the source-slot templates before this change).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md': [ '93e9552c6662811e597a97296f3776a4','1f3c5d077a5ef9a4b610335d5e3edd9c', 'b5c47c94ffc74637983c95761ab0c66c', '49a208628290543ba2607a5ed48fdc8c'],
  'pipeline-prose.md':          [ '84523d531eeafa60959c65c553b2563f','d1f8e3f1d214725b5aa67f309a81cd7d', 'bef1bc2767b78f585f2bd89f3d615130', '25e3d58c2741bd98acd5d08ba70d8a5e', '430d38ed2da59e0d4212e65edc499a74'],
  'pipeline-comic-script.md':   [ 'a4303016c34b65e4b0e641fe71252de3','133d200d069c2e8173b7c129eea58f53', 'e530fc76b89cedaef848ad7ec99c934c', 'dea7d497d1cb38e7574f236f4ff8e644', 'e9ee70bf18888492edada6633cd9928a', '7c05ecde539f04c9fa91e87543057204'],
  'pipeline-teleplay.md':       ['1280ef6b1ad68fa44070ca7478ec2a5f', '2568e14beaa574d43f8018a5def51d04', 'afa4215330bf856429d70d7e2f856605'],
};

// Post-change shipped hashes (the source-agnostic + tilde-fence templates this
// migration installs). Mirror these into setup-data.js's drift table.
export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': 'd6fa86a435f978336661dcabca67258f', // post-127 (scene markers)
  'pipeline-prose.md':          '4cb3ef48309f3673570cf80e4d544b54', // post-169 (cross-issue continuity)
  'pipeline-comic-script.md':   '49af30c05f008b20f6998a0f113f7d87', // post-127 (scene markers)
  'pipeline-teleplay.md':       '2ea9974ac3803658b2314db1f5818b77', // post-128 (canonical scene list)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'source-agnostic stage prompt',
  customizedHint: (filename) =>
    `   To apply the source-agnostic {{#sourceMaterials}} block manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and replace the hardcoded {{stages.*.content}} / {{seed}}-only source\n` +
    `   slot with the {{#sourceMaterials}} loop.`,
  skipFooter: (count) =>
    `⚠️  ${count} stage prompt(s) could not be auto-updated because they were\n` +
    `   customized. Generating a stage from a non-default source will still\n` +
    `   work, but those prompts won't render the chosen source until you merge\n` +
    `   the {{#sourceMaterials}} block. See data.reference/prompts/stages/.`,
});

export { applyMigration };
export default { up };
