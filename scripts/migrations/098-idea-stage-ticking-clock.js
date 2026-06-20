/**
 * Surface the series' ticking clock (countdown the reader anticipates) in the
 * idea / beat-sheet stage prompt, and fix the idea template's broken `{{.}}`
 * dot-references inside string-valued Mustache sections.
 *
 * Two changes ship in `pipeline-idea-expansion.md`:
 *
 *   1. A new `{{#tickingClock}}` section renders the pre-built ticking-clock
 *      guidance (from `renderTickingClock(series.arc.tickingClock)`) so the beat
 *      sheet plants, sustains, and pays off the countdown. The arc-level prompts
 *      already fold the clock into their `{{{shapeGuidance}}}` block (#1289);
 *      the per-issue idea stage needed a NEW template variable, which per
 *      CLAUDE.md requires this migration. Follow-up of #1289 (issue #1356).
 *
 *   2. The idea template referenced section values with `{{.}}` inside
 *      string-valued sections (`{{#arcRole}}…{{.}}`, `{{#beats}}…{{.}}`,
 *      `{{#synopsis}}…{{.}}`). PortOS's template engine only binds `{{.}}` to the
 *      current item during *array* iteration — a truthy *string* section renders
 *      its body against the parent context, so `{{.}}` resolved to the whole
 *      context object and emitted the literal `[object Object]`. The neighbor
 *      beat sheets / synopses and the arc-role label were silently corrupted in
 *      every idea prompt. Switched to named references (`{{arcRole}}`,
 *      `{{beats}}`, `{{synopsis}}`), which resolve correctly.
 *
 * `scripts/setup-data.js` only copies *missing* prompts, so existing installs
 * keep their old template until this migration rewrites it. Customization-safe:
 * only installs whose copy still hashes to the known pre-change shipped version
 * are auto-updated; customized prompts are left intact and warned about.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

// Pre-change shipped hash: the post-054 (source-agnostic) idea-expansion body.
export const ACCEPTED_OLD_MD5 = {
  'pipeline-idea-expansion.md': ['49a208628290543ba2607a5ed48fdc8c'],
};

// Post-change shipped hash (ticking-clock section + `{{.}}` → named-ref fixes).
// Mirror this into every earlier migration that tracks the same file
// (003/004/025/054) so their drift-catch tests stay green.
export const NEW_SHIPPED_MD5 = {
  'pipeline-idea-expansion.md': 'c50f016639d41cd8244f5ff13429f997',
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
