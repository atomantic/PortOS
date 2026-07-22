/**
 * Pipeline — Series Autopilot (full autonomous mode)
 *
 * A *conductor* that drives a whole series from its current state to a terminal
 * "story-ready" state by composing the already-shipped pipeline service
 * functions (arc gen, episode gen, arc verify/resolve, volume beats, per-issue
 * text stages, structural script gate, manuscript editorial review). It does NOT
 * re-implement any generation logic — every step delegates to the same service
 * the manual route calls.
 *
 * Resume is a PURE FUNCTION of current state. `resolveNextStep(series, issues,
 * runState, options)` returns the first unmet step from the canonical records,
 * so the orchestrator never persists a step cursor: on restart the user just
 * starts again and it picks up at the first missing thing. Anything already
 * `ready`/`edited` is skipped (`isStageReady`) and every generation runs with
 * `force:false`, so an in-progress series is never clobbered.
 *
 * Lifecycle mirrors editorialAnalysisRunner.js: a single in-memory `runs` map
 * keyed by `seriesId`, a `finished` flag + cleanup timer for terminal-frame
 * replay, the one permitted try/catch boundary inside the fire-and-forget IIFE,
 * and a cancel flag checked between every step.
 *
 * Autonomy: gated on the **cos** domain (server/lib/domainAutonomy.js).
 *   - off      → start is rejected (route → 409).
 *   - dry-run  → emit a `plan` frame of what it WOULD do; no side effects.
 *   - execute  → full run, charging the cos daily action budget per step and
 *                pausing when the budget is exhausted.
 *
 * Two convergence guards stop unbounded LLM spend (a real observed condition —
 * arc verify can surface fresh findings every pass): the arc-verify and
 * editorial-review loops are bounded and, when they can't reach clean, set the
 * run to `paused` with the residual findings for human review rather than
 * looping forever.
 *
* CoS gap-filing (opt-in via `options.fileGaps`): when the autopilot hits a
 * capability/quality gap it can't resolve — a script that won't parse, a render
 * that keeps failing, a verify/editorial gate that stalls, or a run-ending
 * error — it files a deduped CoS task (`fileGap`) so the gap is tracked instead
 * of silently swallowed.
 *
 * SCRIPT VERIFICATION — the per-issue scriptVerify step has two gates: a
 * STRUCTURAL gate (does the script parse into pages/panels — a failure blocks
 * page extraction, so it files a gap) and a CRAFT gate (the
 * `pipeline-script-verify` LLM pass via verifyComicScript). The craft gate is
 * ADVISORY: script craft is subjective and the gating quality pass is the
 * series-level editorial review, so blocking craft findings are surfaced + filed
 * (not auto-rewritten, not a hard pause) and the run keeps moving toward a draft.
 *
* CANON GATE: before any visual production, a series-level canonVerify step
 * (canonReadiness.js) checks that every canon noun appearing where it'd be
 * DRAWN (comic-script panels / teleplay) has a description. Undescribed drawn
 * nouns pause the run for human review — an artist can't render a name. (An
 * off-page noun named only in prose narration is never drawn, so it doesn't
 * block here; it's a Nouns-stage quality note.)
 *
 * DRAFT VISUALS (Phase 2, VISUAL_DRAFT_ENABLED): once a story is text-ready,
 * extract comic pages from the script (if not already), then enqueue PROOF
 * (draft) renders for the front cover, back cover, and every interior page —
 * replicating the per-slot jobId persistence the render routes do at the route
 * layer (buildRenderSlot → updateStageWithLatest). Renders are async media jobs:
 * we fire the kickoff, persist the in-flight slot, and do NOT block on pixels
 * (mirrors autoRunner's episodeVideo fire-and-forget). Each render is one
 * billable cos action and is budget-gated individually (a comic is many GPU
 * jobs), and already-enqueued slots are skipped so a resumed run doesn't
 * re-render. Gated behind `options.includeVisual`.
 *
 * This file had grown to 2,541 lines mixing config resolution, pure step
 * resolution, session/SSE plumbing, a dozen step runners, dry-run planning and
 * the orchestrator. Issue #2842 split it into ./seriesAutopilot/* the same way
 * #1152 split `arcPlanner.js`; this barrel re-exports everything so existing
 * `from './seriesAutopilot.js'` imports keep working. New code may import the
 * focused module directly.
 */

export * from './seriesAutopilot/state.js';
export * from './seriesAutopilot/config.js';
export * from './seriesAutopilot/convergence.js';
export * from './seriesAutopilot/stepResolver.js';
export * from './seriesAutopilot/session.js';
export * from './seriesAutopilot/childRuns.js';
export * from './seriesAutopilot/editorialSteps.js';
export * from './seriesAutopilot/visualSteps.js';
export * from './seriesAutopilot/revisionSteps.js';
export * from './seriesAutopilot/dispatch.js';
export * from './seriesAutopilot/dryRun.js';
export * from './seriesAutopilot/orchestrator.js';

// Export internals for tests. Pulled back together from their new home modules
// so the existing `__testing` import contract survives the #2842 split.
import { runs } from './seriesAutopilot/state.js';
import { summarizePlanCost } from './seriesAutopilot/convergence.js';
import { providerOverrideOpts, providerIdOpts } from './seriesAutopilot/session.js';
import { meanQualityScore } from './seriesAutopilot/revisionSteps.js';
import { buildDryRunPlan } from './seriesAutopilot/dryRun.js';

export const __testing = { runs, buildDryRunPlan, summarizePlanCost, providerOverrideOpts, providerIdOpts, meanQualityScore };
