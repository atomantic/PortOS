/**
 * Constrain the idea / beat-sheet stage to THIS issue's synopsis scope so
 * adjacent issues stop dramatizing the same arc beat (issue #1513).
 *
 * Two kinds of change ship in `pipeline-idea-expansion.md`:
 *
 *   1. Scope-boundary language. The prior/next-issue neighbor blocks and the
 *      beat-sheet instructions now frame neighboring issues as hard boundaries
 *      ("OUT OF SCOPE", "do NOT cross into them", "stop AT this issue's
 *      cliffhanger, not past it") rather than as material to continue into —
 *      directly targeting the observed failure where issue N's beats ran
 *      through issue N+1's climax.
 *
 *   2. A new `{{#paddingRisk}}` section (NEW template variable, which per
 *      CLAUDE.md requires this migration). It renders only when the issue's
 *      synopsis is terse relative to its length profile — the padding pressure
 *      that makes a long-profile issue absorb the next issue's events to hit
 *      the page target. `assessSynopsisScope` in `server/lib/issueLength.js`
 *      computes the flag; `buildIdeaContextAugment` feeds it into the prompt.
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old template until this migration rewrites it. Customization-safe:
 * only installs whose copy still hashes to the known pre-change shipped version
 * are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
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
  'pipeline-idea-expansion.md': 'd6fa86a435f978336661dcabca67258f', // post-127 (scene markers)
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
