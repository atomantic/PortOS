/**
 * Pipeline cover + print routes — front/back cover concepts and renders for
 * both scopes (volume/season covers on the series record, comic-issue covers
 * on stages.comicPages) plus the print-ready PDF exports (volume.pdf,
 * comic.pdf). The cover-render factory lives here because all four render
 * routes share it.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import {
  pipelinePdfQuerySchema,
  coverRenderSchema,
  backCoverRenderSchema,
  volumeCoverConceptsSchema,
  comicCoverConceptsSchema,
} from '../../lib/pipelineMediaValidation.js';
import * as arcPlanner from '../../services/pipeline/arcPlanner.js';
import {
  renderComicCover,
  renderComicBackCover,
  renderVolumeCover,
  renderVolumeBackCover,
} from '../../services/pipeline/visualStages.js';
import { buildComicPdf } from '../../services/pipeline/comicPdf.js';
import { buildVolumePdf } from '../../services/pipeline/volumePdf.js';
import { mapServiceError } from './shared.js';

const router = Router();

// =====================
// Volume (season) covers — front + back illustration on the season record.
// Stored on series.seasons[].cover / .backCover, sanitized by sanitizeSeason,
// rendered by renderVolumeCover{,BackCover}, stamped on completion by
// seasonCoverFilenameHook. Compiled with all child issues into a trade-
// paperback PDF by the volume.pdf route below.
// =====================

router.post('/series/:id/seasons/:seasonId/cover-concepts/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(volumeCoverConceptsSchema, req.body ?? {});
  const result = await arcPlanner.generateVolumeCoverConcepts(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Cover-render route factory — shared by the four cover-render routes (volume
// front/back + comic-issue front/back). The enqueue+persist flow (build the
// render slot, script-gate, write it onto the record through the serialized
// write tail) now lives in the shared `renderXxx` service entry points
// (visualStages.js) so the route and the CDO orchestrator tool share ONE code
// path (#2220). The route keeps only Zod validation, service dispatch, and
// response shaping.
const makeCoverRenderHandler = ({ schema, render, buildResponse }) => asyncHandler(async (req, res) => {
  const body = validateRequest(schema, req.body ?? {});
  const result = await render(req, body).catch((err) => { throw mapServiceError(err); });
  res.json(buildResponse({ result, req }));
});

// Render the volume front cover. `renderVolumeCover` persists the in-flight
// render slot onto season.cover through updateSeasonOnSeries (queue-serialized)
// — the season-cover filename hook stamps the completed filename later.
// (Missing series / season surface as PIPELINE_SEASON_NOT_FOUND from
// enqueueVolumeCoverLike's loadSeasonContext, mapped to 404 by mapServiceError.)
router.post('/series/:id/seasons/:seasonId/cover/render', makeCoverRenderHandler({
  schema: coverRenderSchema,
  render: (req, body) => renderVolumeCover(req.params.id, req.params.seasonId, body),
  buildResponse: ({ result }) => result,
}));

router.post('/series/:id/seasons/:seasonId/back-cover/render', makeCoverRenderHandler({
  schema: backCoverRenderSchema,
  render: (req, body) => renderVolumeBackCover(req.params.id, req.params.seasonId, body),
  buildResponse: ({ result }) => result,
}));

// Compile a trade-paperback PDF: volume front → for each issue
// [issue front → issue pages → issue back] → volume back → optional colophon.
// 409 with ERR_NO_VOLUME_COVER when the season has no rendered front cover;
// 409 with ERR_NO_RENDERED_ISSUES when no issue has any rendered page yet.
router.get('/series/:id/seasons/:seasonId/volume.pdf', asyncHandler(async (req, res) => {
  const query = validateRequest(pipelinePdfQuerySchema, req.query);
  const size = query.size;
  const includeColophon = query.colophon !== 'skip';
  const { bytes, filename } = await buildVolumePdf(req.params.id, req.params.seasonId, {
    size, includeColophon,
  }).catch((err) => { throw mapServiceError(err); });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(bytes.length));
  res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}));

// Generate front + back cover-art concepts for one comic issue via the LLM.
// Per-issue sibling of /series/:id/seasons/:seasonId/cover-concepts/generate.
// `target` ('cover' | 'backCover' | 'both') gates which slots can be seeded
// when `commit: true` — the UI button on each card sends its own target so
// the user can regenerate one without touching the other. Seeds only blank
// scripts; never clobbers a user edit.
router.post('/issues/:id/cover-concepts/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(comicCoverConceptsSchema, req.body ?? {});
  const result = await arcPlanner.generateComicCoverConcepts(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Render the comic-issue front cover. Builds a cover-art prompt (series
// masthead + issue-number tag + the user's cover concept) and persists the
// returned jobId on stages.comicPages.cover.imageJobId. Pass `coverScript`
// in the body to override or update the persisted cover concept in the
// same call. Returns { jobId, mode, prompt, cover, issue, stage }.
// Missing issue surfaces as PIPELINE_ISSUE_NOT_FOUND from enqueueComicCover's
// loadBibleContext (its first step is getIssue), mapped to 404 by
// mapServiceError. The seeded slot's `filename: null` lets the UI render an
// "in-flight" thumb without showing the previous render while the new job is
// running; the filename hook stamps `filename` on completion.
router.post('/issues/:id/stages/comicPages/cover/render', makeCoverRenderHandler({
  schema: coverRenderSchema,
  render: (req, body) => renderComicCover(req.params.id, body),
  buildResponse: ({ result }) => ({ ...result, cover: result.stage.cover }),
}));

// Render the comic-issue BACK cover. Same flow as the front-cover route;
// differs in the prompt (no masthead, explicit no-text negative) and the
// persisted slot (`stages.comicPages.backCover.{proofImage|finalImage}`).
router.post('/issues/:id/stages/comicPages/back-cover/render', makeCoverRenderHandler({
  schema: backCoverRenderSchema,
  render: (req, body) => renderComicBackCover(req.params.id, body),
  buildResponse: ({ result }) => ({ ...result, backCover: result.stage.backCover }),
}));

// Print-ready PDF export of a comic issue's rendered pages. Streams the
// assembled PDF straight to the response — no on-disk artifact, so a new
// render is always a fresh assembly. ?size= picks paper format
// (us-letter|a4|tabloid). 409 when the issue has no rendered cover/pages.
router.get('/issues/:id/comic.pdf', asyncHandler(async (req, res) => {
  const query = validateRequest(pipelinePdfQuerySchema, req.query);
  const size = query.size;
  const includeCover = query.cover !== 'skip';
  const includeBackCover = query.backCover !== 'skip';
  const includeColophon = query.colophon !== 'skip';
  const { bytes, filename } = await buildComicPdf(req.params.id, {
    size, includeCover, includeBackCover, includeColophon,
  }).catch((err) => { throw mapServiceError(err); });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(bytes.length));
  // Zero-copy aliasing: Buffer shares the Uint8Array's ArrayBuffer instead of
  // duplicating tens of MB for a multi-page PDF.
  res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}));

export default router;
