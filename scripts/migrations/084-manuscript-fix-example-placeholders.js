/**
 * Make the manuscript-fix prompt's JSON example obviously schematic so weaker models stop echoing it back as their answer.
 *
 * A "Generate fix" run returned the example's VALUES verbatim (`find: "a verbatim excerpt copied EXACTLY…"`, `replace: "that same span rewritten…"`) instead of a real span + rewrite, because the old example read like filled-in content. This replaces those prose-style placeholders with bracketed `<…>` field descriptions and adds an explicit "bracketed values are descriptions, do not copy them" rule; a runtime guard in server/services/pipeline/manuscriptFix.js (normalizeFix → isEchoedPlaceholder) also drops an edit whose find/replace still matches either the old or new placeholder text, so an echo collapses to the existing "did not return a usable fix — try again" retry.
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs keep the old template until this rewrites it. Customization-safe: only copies hashing to a known prior shipped version are auto-updated; customized prompts are left intact and warned about. Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash: the post-066 (replacementStrategy) fix body.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-manuscript-fix.md': ['88199bf7b5b50155bd2e1624bd920ebd'],
};

// Post-change shipped hash (bracketed example + don't-echo rule). Mirror this
// into every earlier migration that tracks the same file (060/066) so their
// drift-catch tests stay green.
export const NEW_SHIPPED_MD5 = {
  'pipeline-manuscript-fix.md': 'e2baaf0f2f53c8aa1e934a428c0ca583',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'manuscript-fix example placeholders',
  customizedHint: (filename) =>
    `   To harden the example manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and replace the JSON example's prose placeholder values with bracketed\n` +
    `   <…> field descriptions plus a "do not copy the bracketed values" rule.`,
  skipFooter: (count) =>
    `⚠️  ${count} manuscript-fix prompt(s) could not be auto-updated because\n` +
    `   they were customized. Fixes still work, but a weaker model may echo the\n` +
    `   JSON example back as its answer until you harden the example (the\n` +
    `   runtime guard still drops such echoes — they surface as "did not return\n` +
    `   a usable fix — try again").\n` +
    `   See data.reference/prompts/stages/pipeline-manuscript-fix.md.`,
});

export { applyMigration };
export default { up };
