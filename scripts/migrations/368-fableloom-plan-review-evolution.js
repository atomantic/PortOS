/**
 * Map tested control belief through cost to behavioral proof in the FableLoom
 * series-plan review (#6443, epic #6418).
 *
 * The shipped template evaluated arc, escalation, pacing, side-quest lifecycle,
 * continuity, thematic coherence and per-episode dramatic job — and said
 * nothing about character transformation being EARNED BY BEHAVIOR. Two
 * consequences at plan time: a climax that wins the external fight read as a
 * clean payoff even with no behavioral proof anywhere in the plan, and a
 * deliberately flat or tragic ending read as an arc gap.
 *
 * The new `{{characterEvolutions}}` section carries the staged causal chain
 * plus the declared outcome, makes the outcome change the verdict rather than
 * suppress the pass, and splits "no authored intent" from "authored intent not
 * delivered" so the two get different repairs. It also states explicitly that a
 * satisfied lens contributes NOTHING — a plan review that always emitted an
 * evolution risk would spin `editorialAutopilot.runPlanning()` to `maxRounds`.
 *
 * The section is mustache-gated and the variable renders '' when no lens is
 * authored, so an install with no lens sends a byte-identical prompt to the
 * pre-migration one. Hash replacement preserves customized prompts.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-review-series-plan.md': ['1c1ab552f6f6a4d9d51f1d3bacd89122'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-review-series-plan.md': '588c82fafd733581490f24cb6fb4bfa7',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom plan review maps belief → cost → behavioral proof',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the\n` +
    '   "Authored character evolution (five-stage lens)" section with its\n' +
    '   {{characterEvolutions}} block, declared-outcome rulings, and the\n' +
    '   "no authored intent" / "authored intent not delivered" split.',
});

export { applyMigration };
export default { up };
