/**
 * Pipeline: Series Autopilot (full autonomous mode).
 *
 * A *conductor* composing the existing pipeline services to drive a series to
 * "story-ready"; it re-implements no generation logic. Barrel over
 * ./seriesAutopilot/* so existing `from './seriesAutopilot.js'` imports work.
 *
 * Resume is a PURE FUNCTION of current state (`resolveNextStep`): no step cursor
 * is persisted, `ready`/`edited` stages are skipped, generation uses `force:false`.
 * Lifecycle mirrors editorialAnalysisRunner.js (in-memory `runs` map, terminal-
 * frame replay, one permitted try/catch in the fire-and-forget IIFE).
 *
 * Gated on the **cos** domain (server/lib/domainAutonomy.js): off rejects start
 * (409); dry-run emits a `plan` frame; execute charges the cos daily action
 * budget per step and pauses when exhausted. The arc-verify and editorial loops
 * are bounded and pause with residual findings rather than spend unboundedly.
 *
 * Script verification: the STRUCTURAL gate blocks page extraction and files a
 * gap; the CRAFT gate is ADVISORY (findings surfaced and filed, never auto-rewritten).
 * CANON GATE: `canonVerify` (canonReadiness.js) requires every canon noun that
 * would be DRAWN to have a description; unsupported ones pause the run.
 * DRAFT VISUALS (`options.includeVisual`): fire-and-forget PROOF renders for
 * covers and pages, each budget-gated; already-enqueued slots are skipped.
 */

export * from './seriesAutopilot/state.js';
export * from './seriesAutopilot/config.js';
export * from './seriesAutopilot/convergence.js';
export * from './seriesAutopilot/discardedEvidence.js';
export * from './seriesAutopilot/stepResolver.js';
export * from './seriesAutopilot/session.js';
export * from './seriesAutopilot/diagnosisCore.js';
export * from './seriesAutopilot/selfImprove.js';
export * from './seriesAutopilot/observer.js';
export * from './seriesAutopilot/modelPerformance.js';
export * from './seriesAutopilot/childRuns.js';
export * from './seriesAutopilot/editorialSteps.js';
export * from './seriesAutopilot/visualSteps.js';
export * from './seriesAutopilot/revisionSteps.js';
export * from './seriesAutopilot/unlockPass.js';
export * from './seriesAutopilot/arcSteps.js';
export * from './seriesAutopilot/dispatch.js';
export * from './seriesAutopilot/dryRun.js';
export * from './seriesAutopilot/orchestrator.js';
export { recoverStuckAutopilots } from './recovery.js';

// Test internals, pulled from their home modules. Lazy getters because a real
// import cycle (session -> autoRunner -> episodeVideo -> completionHook ->
// planAdvance -> seriesAutopilot) once made eager reads a TDZ error on cold
// import; `seriesAutopilotColdImport.test.js` guards against its return.
import * as state from './seriesAutopilot/state.js';
import * as convergence from './seriesAutopilot/convergence.js';
import * as session from './seriesAutopilot/session.js';
import * as revisionSteps from './seriesAutopilot/revisionSteps.js';
import * as dryRun from './seriesAutopilot/dryRun.js';

export const __testing = {
  get runs() { return state.runs; },
  get buildDryRunPlan() { return dryRun.buildDryRunPlan; },
  get summarizePlanCost() { return convergence.summarizePlanCost; },
  get roleLlm() { return session.roleLlm; },
  get providerOverrideOpts() { return session.providerOverrideOpts; },
  get providerIdOpts() { return session.providerIdOpts; },
  get meanQualityScore() { return revisionSteps.meanQualityScore; },
};
