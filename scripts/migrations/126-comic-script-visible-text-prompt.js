/**
 * Harden the comic-script prompt against unspecified visible in-world text.
 *
 * Series Autopilot's script-craft pass can catch a panel that says a second
 * draft line appears/highlights/vanishes without specifying what the line says,
 * but the generation prompt did not tell the model that readable text inside
 * the art must be exact and stable across panels. This migration ships that
 * rule so comic scripts give artists and letterers concrete text to draw.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-comic-script.md': [
    'e9ee70bf18888492edada6633cd9928a', // post-063 (panel decomposition)
    '7c05ecde539f04c9fa91e87543057204', // pre-126 (current reference body)
  ],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-comic-script.md': 'a4303016c34b65e4b0e641fe71252de3', // post-126 (visible text exactness)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'comic-script visible-text prompt',
  customizedHint: (filename) =>
    `   To add the visible-text exactness rule manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the rule requiring exact quoted words for readable in-world\n` +
    `   text that appears, highlights, changes, or vanishes across panels.`,
  skipFooter: (count) =>
    `⚠️  ${count} comic-script prompt(s) could not be auto-updated because\n` +
    `   they were customized. Comic scripts still generate, but visible\n` +
    `   in-world text may remain underspecified until you merge the prompt\n` +
    `   change manually.\n` +
    `   See data.reference/prompts/stages/pipeline-comic-script.md.`,
});

export { applyMigration };
export default { up };
