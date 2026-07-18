/**
 * Update the `cd-plan` stage prompt to document cross-step RESULT REFERENCES
 * (`{{steps.<stepId>.result.<key>}}`) so the Creative Director planner can thread
 * a just-minted id into a later step's args.
 *
 * Background (#2773): the CD plan executor dispatches each step's pre-authored
 * `args` verbatim and never interpolated a prior step's output. A `series`
 * commission therefore could only ever create an EMPTY series — the planner had
 * no way to reference the id `pipeline_createSeries` mints when handing it to
 * `pipeline_startSeriesAutopilot`. The executor now resolves
 * `{{steps.<stepId>.result.<key>}}` references at dispatch time
 * (server/services/creativeDirector/planAdvance.js#resolvePlanStepArgs); this
 * prompt change teaches the planner the syntax so it actually emits them.
 *
 * Strategy: hash-driven prompt-replace via `./_lib.js`. Idempotent — only an
 * install still carrying the pre-change (post-193) shipped template is
 * auto-updated; a customized copy is left alone with a merge hint.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'cd-plan.md': ['0768d6809645c2c1fe73cacae9740fe9'], // post-193 shipped (locked render settings)
};

export const NEW_SHIPPED_MD5 = {
  'cd-plan.md': 'ef0d96f6ebde43af6c4579969d31cfb7', // post-199 (cross-step result references)
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'creative-director stage prompt',
  customizedHint: (filename) =>
    `   To apply the result-reference note manually, diff:\n` +
    `     data.reference/prompts/stages/${filename}\n` +
    `   against your current:\n` +
    `     data/prompts/stages/${filename}\n` +
    `   and add the "## Referencing a prior step's result" section.`,
  skipFooter: (count) =>
    `⚠️  ${count} cd-plan prompt(s) could not be auto-updated because they were customized.\n` +
    `   Series/multi-step commissions still work when the planner already threads\n` +
    `   ids, but it won't learn the {{steps.…}} syntax until you merge the note.`,
});

export { applyMigration };
export default { up };
