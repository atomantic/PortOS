/**
 * Two related prompt updates, bundled because they touch overlapping files:
 *
 *   (a) Add `{{worldEntitiesSummary}}` block to the three per-issue text-stage
 *       prompts so they receive a compact one-line-per-kind synopsis of the
 *       linked Universe Builder's canon.
 *
 *   (b) Pipe the new `speechPattern` (and accompanying `speechAccent`)
 *       character bible field through the same three script-stage prompts +
 *       the universe-character-expand prompt so dialogue carries the
 *       character's prose voice on the page.
 *
 * Updates (per ACCEPTED_OLD_MD5 below):
 *   - data/prompts/stages/pipeline-prose.md
 *   - data/prompts/stages/pipeline-teleplay.md
 *   - data/prompts/stages/pipeline-comic-script.md
 *   - data/prompts/stages/universe-character-expand.md
 *
 * Why:
 *   Text stages historically only got `{{#series.characters}}` (the series
 *   bible). When a series is linked to a Universe Builder world, that bible
 *   excludes universe-level places/objects and other characters that haven't
 *   been pulled into the series canon — so scripts could namelessly drift
 *   from established continuity even when the universe had a rich roster.
 *   `worldEntitiesSummary` is a budget-aware alternative to the full
 *   `worldCanonText` block: one tagged line per kind, capped at 8 entries.
 *
 *   Separately, `speechAccent` historically conflated regional accent with
 *   speech patterns (cadence/lexicon/tics). Splitting it into a dedicated
 *   `speechPattern` field lets the universe-character-expand pass populate
 *   them independently, and lets the three script stages quote both for
 *   dialogue continuity.
 *
 * Implementation: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-prose.md': [
    '30ac30ec2b9d3e2a9eb869c181732cc6', // post-003 / pre-027 shipped
    'bfea5aeeb471aae9749baee765b473a7', // pre-003 (in setup-data OLD list)
    'd1f8e3f1d214725b5aa67f309a81cd7d', // post-027 / pre-054
    'bef1bc2767b78f585f2bd89f3d615130', // post-054 / pre-054-fence
  ],
  'pipeline-teleplay.md': [
    '376f779f4687b598f1c92ca4e770fd5a', // pre-027 shipped
    '3f6fecc25573ed054b47db392250034a', // pre-shape (in setup-data OLD list)
    '1280ef6b1ad68fa44070ca7478ec2a5f', // post-027 / pre-054
    '2568e14beaa574d43f8018a5def51d04', // post-054 / pre-054-fence
  ],
  'pipeline-comic-script.md': [
    '1e0af305c27d0c80c4b482d2ebcb4a0d', // post-011 / pre-027 shipped
    'beab031951859ca13579cdb9c4dbe769', // pre-011 (in setup-data OLD list)
    '40e5fdc1a1e68a7419b7dad936366c1a', // pre-003 (in setup-data OLD list)
    '133d200d069c2e8173b7c129eea58f53', // post-027 / pre-054
    'e530fc76b89cedaef848ad7ec99c934c', // post-054 / pre-054-fence
  ],
  'universe-character-expand.md': [
    'ef109eb8e12ddb664c11c790271b5139', // pre-027 shipped
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-prose.md':            '84523d531eeafa60959c65c553b2563f', // post-054-fence
  'pipeline-teleplay.md':         'afa4215330bf856429d70d7e2f856605', // post-054-fence
  'pipeline-comic-script.md':     'dea7d497d1cb38e7574f236f4ff8e644', // post-054-fence
  'universe-character-expand.md': '67b6e73ed47f318451a730088b4cff14',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'text-stage entities-summary + speechPattern',
  customizedHint: (filename) =>
    `   To pick up {{worldEntitiesSummary}} + {{speechPattern}} / {{speechAccent}} manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the new blocks in the same position as in the sample template.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were customized.\n` +
    `   The {{worldEntitiesSummary}} block + {{speechPattern}} / {{speechAccent}} renderers\n` +
    `   will not appear in those prompts until the files are merged manually. See\n` +
    `   data.reference/prompts/stages/.`,
});

export { applyMigration };
export default { up };
