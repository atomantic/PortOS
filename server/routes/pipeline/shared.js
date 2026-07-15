/**
 * Shared plumbing for the pipeline sub-routers: the service-error → HTTP
 * status map, the provider/model override schema fragment, and the canon
 * extraction count helper used by both the arc and issue routers.
 */

import { z } from 'zod';
import { createServiceErrorMapper } from '../../lib/errorHandler.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as seasonsSvc from '../../services/pipeline/seasons.js';
import * as arcPlanner from '../../services/pipeline/arcPlanner.js';
import * as manuscriptFix from '../../services/pipeline/manuscriptFix.js';
import { ERR_NO_STORYBOARDS } from '../../services/pipeline/episodeVideo.js';
import { ERR_NO_RENDERED_PAGES } from '../../services/pipeline/comicPdf.js';
import { ERR_NO_VOLUME_COVER, ERR_NO_RENDERED_ISSUES } from '../../services/pipeline/volumePdf.js';
import { ERR_NO_PROSE } from '../../services/pipeline/proseExport.js';
import { buildCascadeContext } from '../../services/recordMerge.js';

const SERVICE_ERROR_STATUS = {
  [seriesSvc.ERR_NOT_FOUND]: 404,
  [seriesSvc.ERR_VALIDATION]: 400,
  [issuesSvc.ERR_NOT_FOUND]: 404,
  [issuesSvc.ERR_VALIDATION]: 400,
  // Per-season-lock errors map to 409 (the lock-conflict idiom — same status
  // ERR_NO_VOLUME_COVER and friends use) so the client can disambiguate a
  // locked-resource refusal from a malformed-payload 400.
  [issuesSvc.ERR_SEASON_LOCKED]: 409,
  [seasonsSvc.ERR_LOCKED]: 409,
  [seasonsSvc.ERR_NOT_FOUND]: 404,
  [seasonsSvc.ERR_VALIDATION]: 400,
  [seasonsSvc.ERR_REASSIGN_TARGET]: 400,
  [arcPlanner.ERR_VALIDATION]: 400,
  [manuscriptFix.ERR_VALIDATION]: 400,
  [manuscriptFix.ERR_NOT_FOUND]: 404,
  PIPELINE_REVIEW_NOT_FOUND: 404,
  [ERR_NO_STORYBOARDS]: 400,
  [ERR_NO_RENDERED_PAGES]: 409,
  [ERR_NO_VOLUME_COVER]: 409,
  [ERR_NO_RENDERED_ISSUES]: 409,
  // Prose-export refusal when no issue has drafted prose (#2181) → 409, same
  // "resource not ready for this action" idiom as the PDF exports above.
  [ERR_NO_PROSE]: 409,
  // recordMerge validation (unresolved conflicts, bad ids, cross-universe).
  MERGE_VALIDATION: 400,
  // recordMerge cascade partially completed (the issue reassign failed) → 409 so
  // the client can surface "merge incomplete, re-run to finish".
  MERGE_CASCADE_INCOMPLETE: 409,
};

// An incomplete merge cascade forwards the survivor/loser ids + which step
// failed (via buildCascadeContext) so the UI can tell the user exactly what
// didn't move.
export const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS, buildCascadeContext);

// Arc / season-episodes / verify — Phase 3 of Story Arc Planning. The LLM
// calls share a provider/model override shape.
export const providerOverrideShape = {
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(200).optional(),
};

// Collapses the `extractCanonFromProse` result-shape trio used by both the
// season-episodes continuity extract and the manual script-stage extract.
export const countExtractedCanon = (results) => ({
  characters: results.characters?.extracted?.length || 0,
  places: results.places?.extracted?.length || 0,
  objects: results.objects?.extracted?.length || 0,
});
