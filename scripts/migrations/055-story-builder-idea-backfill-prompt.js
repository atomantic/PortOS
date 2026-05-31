/**
 * Add the optional `{{sourceMaterial}}` backfill block to the Story Builder
 * idea-expand prompt.
 *
 * The Story Builder can now reverse-engineer the starting idea from a series'
 * existing issue content (the "started from a drafted comic script" case). When
 * the user backfills the idea step, the conductor passes the concatenated issue
 * corpus as `sourceMaterial`; the prompt renders it under a new section and is
 * told to extract the premise already on the page. The forward (seed-only) path
 * is unchanged — the section only renders when `sourceMaterial` is non-empty.
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old template until this migration rewrites it. Customization-safe:
 * only an install whose copy still hashes to the known pre-change shipped
 * version is auto-updated; a customized prompt is left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'story-builder-idea-expand.md': ['a23939626a226f7420cebfb45d47950c', '778c86e2caa120856c36e4d5a4da3355'],
};

export const NEW_SHIPPED_MD5 = {
  'story-builder-idea-expand.md': 'c12d76fefaaded2838023065bfc94bb0',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'story-builder idea backfill prompt',
  customizedHint: (filename) =>
    `   To apply the {{sourceMaterial}} backfill block manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the {{#sourceMaterial}} … {{/sourceMaterial}} section after the seed.`,
  skipFooter: (count) =>
    `⚠️  ${count} story-builder prompt could not be auto-updated because it was\n` +
    `   customized. Backfilling the idea from existing issues will still run, but\n` +
    `   the prompt won't render the source material until you merge the section.`,
});

export { applyMigration };
export default { up };
