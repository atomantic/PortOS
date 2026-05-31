/**
 * Add `comic-structure` category to the manuscript-completeness prompt.
 *
 * The prompt previously had five finding categories (missing-content, arc-gap,
 * character-gap, pacing, continuity) — all narrative-level. Comic scripts have
 * a structural failure mode that none of them catch: pages where an author or AI
 * stage dumps all scene content into the page-level description instead of
 * breaking it into panel definitions. The image generator and letterer work
 * panel-by-panel, so such pages cannot be rendered.
 *
 * The new `comic-structure` category surfaces these pages as `high`-severity
 * findings and requires the suggestion to be a full panel-by-panel rewrite of
 * the malformed page (directly substitutable via the find-and-replace fix path).
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old template until this migration rewrites it. Customization-safe:
 * only installs whose copy still hashes to the known pre-change shipped version
 * are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash (five-category, anchorQuote findings from migration 056).
export const ACCEPTED_OLD_MD5 = {
  'pipeline-manuscript-completeness.md': ['4f2b95778aed85f5fc461d71eb461b79'],
};

// Post-change shipped hash (six-category with comic-structure).
// Mirror this into setup-data.js's drift table.
export const NEW_SHIPPED_MD5 = {
  'pipeline-manuscript-completeness.md': '1ee5ac936fbf1d365e0eaea99bcf1e77',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'manuscript-completeness comic-structure category prompt',
  customizedHint: (filename) =>
    `   To add comic-structure detection manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the comic-structure category to "What to look for" and the output contract.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were\n` +
    `   customized. Editorial review still works, but comic-script pages\n` +
    `   that lack proper panel definitions won't be flagged as structural\n` +
    `   issues until you merge the change.\n` +
    `   See data.reference/prompts/stages/pipeline-manuscript-completeness.md.`,
});

export { applyMigration };
export default { up };
