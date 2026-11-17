/**
 * Constrain the idea / beat-sheet stage to THIS issue's synopsis scope so adjacent issues stop dramatizing the same arc beat (issue #1513).
 *
 * Two changes ship in `pipeline-idea-expansion.md`: (1) scope-boundary language: the prior/next-issue neighbor blocks and beat-sheet instructions frame neighboring issues as hard boundaries ("OUT OF SCOPE", "do NOT cross into them", "stop AT this issue's cliffhanger") rather than material to continue into, targeting the failure where issue N's beats ran through N+1's climax;
 * (2) a `{{#paddingRisk}}` section (a NEW template variable, which per CLAUDE.md requires this migration), rendered only when the synopsis is terse relative to its length profile (the padding pressure that makes a long-profile issue absorb the next issue's events); `assessSynopsisScope` in `server/lib/issueLength.js` computes the flag and `buildIdeaContextAugment` feeds it in.
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs keep the old template until this rewrites it. Customization-safe: only copies hashing to the known pre-change shipped version are auto-updated; customized prompts are left intact and warned about. Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash: the post-098 (ticking-clock) idea-expansion body.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md': [ '93e9552c6662811e597a97296f3776a4','c50f016639d41cd8244f5ff13429f997'],
};

// Post-change shipped hash (scope-boundary language + {{#paddingRisk}} section).
// Mirror this into every earlier migration that tracks the same file
// (003/004/025/054/098) so their drift-catch tests stay green.
export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': 'a032e4a724251ed3e3495d33c4dbab8e', // post-127 (scene markers)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'idea-stage scope-discipline prompt',
  customizedHint: (filename) =>
    `   To constrain beats to the issue's scope manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the scope-boundary language plus the {{#paddingRisk}} section.`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were\n` +
    `   customized. The idea stage still works, but its beats may run past\n` +
    `   the issue's synopsis scope (and adjacent issues can duplicate the\n` +
    `   same beat) until you merge the change. See\n` +
    `   data.reference/prompts/stages/pipeline-idea-expansion.md.`,
});

export { applyMigration };
export default { up };
