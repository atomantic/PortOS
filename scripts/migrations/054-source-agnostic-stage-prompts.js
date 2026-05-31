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
  'pipeline-idea-expansion.md': ['1f3c5d077a5ef9a4b610335d5e3edd9c', 'b5c47c94ffc74637983c95761ab0c66c'],
  'pipeline-prose.md':          ['d1f8e3f1d214725b5aa67f309a81cd7d', 'bef1bc2767b78f585f2bd89f3d615130'],
  'pipeline-comic-script.md':   ['133d200d069c2e8173b7c129eea58f53', 'e530fc76b89cedaef848ad7ec99c934c'],
  'pipeline-teleplay.md':       ['1280ef6b1ad68fa44070ca7478ec2a5f', '2568e14beaa574d43f8018a5def51d04'],
};

// Post-change shipped hashes (the source-agnostic + tilde-fence templates this
// migration installs). Mirror these into setup-data.js's drift table.
export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': '49a208628290543ba2607a5ed48fdc8c',
  'pipeline-prose.md':          '84523d531eeafa60959c65c553b2563f',
  'pipeline-comic-script.md':   'dea7d497d1cb38e7574f236f4ff8e644',
  'pipeline-teleplay.md':       'afa4215330bf856429d70d7e2f856605',
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
