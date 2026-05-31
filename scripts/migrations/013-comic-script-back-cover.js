/**
 * Add `## Back cover concept` section to the comic-script stage prompt.
 *
 * Before this migration, the comic-script template emitted only a
 * `## Cover concept` section. After: the template also asks the LLM for a
 * `## Back cover concept` (one paragraph, illustration-only, no text), which
 * the parser captures into `backCoverConcept` and the issue's
 * `stages.comicPages.backCover.script` slot reads via the extract-pages
 * route.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-comic-script.md': [
    '40e5fdc1a1e68a7419b7dad936366c1a', // pre-003 (original)
    'beab031951859ca13579cdb9c4dbe769', // post-003 (length-profile feature)
    '1e0af305c27d0c80c4b482d2ebcb4a0d', // post-013 / pre-027 — the hash this migration originally produced
    '133d200d069c2e8173b7c129eea58f53', // post-027 / pre-054
    'e530fc76b89cedaef848ad7ec99c934c', // post-054 / pre-054-fence
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-comic-script.md': 'dea7d497d1cb38e7574f236f4ff8e644', // post-054-fence
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'comic-script back-cover',
  customizedHint: (filename) =>
    `   To add the Back cover concept section manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and merge the new \`## Back cover concept\` block.`,
});

export { applyMigration };
export default { up };
