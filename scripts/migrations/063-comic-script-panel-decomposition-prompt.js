/**
 * Harden the comic-script prompt against content-in-page-description malformation.
 *
 * The `comic-structure` editorial-review category (migration 057) is a
 * *detection* layer — it catches pages where all the action/dialogue landed in
 * the page-level description instead of discrete panels. The root cause is the
 * generation prompt, which never explicitly forbade page-level scene content
 * nor mandated a per-page panel decomposition. This migration ships two new
 * rules in `pipeline-comic-script.md`:
 *   (a) page-level text is layout intent ONLY (1–3 lines max), never action /
 *       dialogue / scene content;
 *   (b) every page MUST decompose into discrete `Panel N` blocks carrying
 *       Description / Caption / Dialogue / SFX (the count follows the existing
 *       rhythm rule — 4–6 typical, splash, or the rare 7–8 grid).
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-comic-script.md': ['dea7d497d1cb38e7574f236f4ff8e644'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-comic-script.md': 'e9ee70bf18888492edada6633cd9928a',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'comic-script panel-decomposition prompt',
  customizedHint: (filename) =>
    `   To add the panel-decomposition rules manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the two rules forbidding page-level scene content and\n` +
    `   mandating discrete Panel blocks per page (count following the\n` +
    `   existing rhythm rule).`,
  skipFooter: (count) =>
    `⚠️  ${count} comic-script prompt(s) could not be auto-updated because\n` +
    `   they were customized. Comic scripts still generate, but pages may\n` +
    `   keep landing all content in the page-level description instead of\n` +
    `   discrete panels until you merge the prompt change.\n` +
    `   See data.reference/prompts/stages/pipeline-comic-script.md.`,
});

export { applyMigration };
export default { up };
