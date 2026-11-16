/**
 * Surface the series' ticking clock (countdown the reader anticipates) in the idea / beat-sheet stage prompt, and fix the idea template's broken `{{.}}` dot-references inside string-valued Mustache sections.
 *
 * Two changes ship in `pipeline-idea-expansion.md`: (1) a new `{{#tickingClock}}` section renders the pre-built guidance (`renderTickingClock(series.arc.tickingClock)`) so the beat sheet plants, sustains and pays off the countdown (arc-level prompts already fold it into `{{{shapeGuidance}}}`, #1289; a NEW template variable requires a migration per CLAUDE.md; issue #1356);
 * (2) the template used `{{.}}` inside string-valued sections (`{{#arcRole}}…{{.}}`, `{{#beats}}…`, `{{#synopsis}}…`), but PortOS's engine binds `{{.}}` to the current item only during *array* iteration (a truthy *string* section renders against the parent context), so it emitted the literal `[object Object]` and silently corrupted beat sheets, synopses and the arc-role label in every idea prompt; switched to named references.
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs keep the old template until this rewrites it. Customization-safe: only copies hashing to the known pre-change shipped version are auto-updated; customized prompts are left intact and warned about. Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash: the post-054 (source-agnostic) idea-expansion body.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md': [ '93e9552c6662811e597a97296f3776a4','49a208628290543ba2607a5ed48fdc8c'],
};

// Post-change shipped hash. Bumped to the current shipped body whenever a later
// migration edits this file, so the drift-catch test (NEW == live sample) stays
// green. Latest: post-124 (scope-discipline + {{#paddingRisk}}).
export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': 'a032e4a724251ed3e3495d33c4dbab8e', // post-127 (scene markers)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'idea-stage ticking-clock prompt',
  customizedHint: (filename) =>
    `   To surface the ticking clock manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the {{#tickingClock}} section (and replace any {{.}} inside\n` +
    `   {{#arcRole}}/{{#beats}}/{{#synopsis}} with the named reference).`,
  skipFooter: (count) =>
    `⚠️  ${count} prompt(s) could not be auto-updated because they were\n` +
    `   customized. The idea stage still works, but it won't surface the\n` +
    `   ticking clock (and any {{.}} dot-refs will keep rendering\n` +
    `   "[object Object]") until you merge the change. See\n` +
    `   data.reference/prompts/stages/pipeline-idea-expansion.md.`,
});

export { applyMigration };
export default { up };
