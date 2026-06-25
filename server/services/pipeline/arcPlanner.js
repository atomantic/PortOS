/**
 * Pipeline — Series Arc Planning Service (re-exporting barrel)
 *
 * Phase 3 of the Story Arc Planning initiative. Owns the LLM-driven planning
 * passes that populate `series.arc` and `series.seasons[]`:
 *
 *   generateArcOverview(seriesId)         → seeds series.arc + series.seasons[]
 *   generateSeasonEpisodes(seriesId, seasonId, { force? })
 *                                          → seeds issues under a season
 *   verifyArc(seriesId)                   → cross-season continuity pass
 *
 * Each function returns `{ result, runId, providerId, model }` so the caller
 * can react to a successful run (persisted via `updateSeries` / `createSeason`
 * / `createIssue` chains as appropriate) and surface the runId in /runs.
 *
 * Extraction-only; mirrors how `bibleExtractor.js` and `sceneExtractor.js`
 * are split — the caller decides whether to persist.
 *
 * This file was 2137 lines mixing four LLM-call-chain concerns plus a shared
 * context layer. Issue #1152 split it into ./arcPlanner/ (context, arcCore,
 * episodeSeedPass, completenessPass, manuscriptDerive, coverConcepts); this
 * barrel re-exports everything so existing `from './arcPlanner.js'` imports
 * keep working. New code may import the focused module directly.
 */

export * from './arcPlanner/context.js';
export * from './arcPlanner/arcCore.js';
export * from './arcPlanner/beatContinuity.js';
export * from './arcPlanner/episodeSeedPass.js';
export * from './arcPlanner/completenessPass.js';
export * from './arcPlanner/manuscriptDerive.js';
export * from './arcPlanner/coverConcepts.js';

// Internals surfaced for tests (was an inline `export const __testing` before
// the split). Pulled back together here from their new home modules so the
// existing `__testing` import contract is preserved.
import { buildArcOverviewContext, shapeSeasonOutlines, buildVerifyContext, buildResolveContext, shapeVerifyIssues, shapeFindings, renderVolumeIssue, buildNeighborVolumes, buildBeatContinuityContext, shapeBeatResolutions } from './arcPlanner/context.js';
import { buildVolumeVerifyContext, mergeArcWithLocks, mergeSeasonsWithLocks } from './arcPlanner/arcCore.js';
import { applyBeatResolutions } from './arcPlanner/beatContinuity.js';
import { buildSeasonEpisodesContext, shapeEpisodes } from './arcPlanner/episodeSeedPass.js';
import { shapeCompletenessFindings, buildCompletenessContext } from './arcPlanner/completenessPass.js';
import { issueSynopsisFromSeason } from './arcPlanner/manuscriptDerive.js';

export const __testing = {
  buildArcOverviewContext,
  buildSeasonEpisodesContext,
  buildVerifyContext,
  buildVolumeVerifyContext,
  buildResolveContext,
  shapeSeasonOutlines,
  shapeEpisodes,
  shapeVerifyIssues,
  shapeFindings,
  shapeCompletenessFindings,
  buildCompletenessContext,
  issueSynopsisFromSeason,
  renderVolumeIssue,
  buildNeighborVolumes,
  mergeArcWithLocks,
  mergeSeasonsWithLocks,
  buildBeatContinuityContext,
  shapeBeatResolutions,
  applyBeatResolutions,
};
