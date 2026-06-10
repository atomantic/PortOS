/**
 * Pipeline cover + print routes — front/back cover concepts and renders for
 * both scopes (volume/season covers on the series record, comic-issue covers
 * on stages.comicPages) plus the print-ready PDF exports (volume.pdf,
 * comic.pdf). The cover-render factory lives here because all four render
 * routes share it.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errorHandler.js';
import {
  validateRequest,
  imageEdgeSchema,
  refineImagePixelCap,
  PIXEL_CAP_MESSAGE,
} from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as arcPlanner from '../../services/pipeline/arcPlanner.js';
import {
  enqueueComicCover,
  enqueueComicBackCover,
  enqueueVolumeCover,
  enqueueVolumeBackCover,
  buildRenderSlot,
} from '../../services/pipeline/visualStages.js';
import { COMIC_PAGE_VARIANTS, slotKeyForVariant } from '../../services/pipeline/owners.js';
import { IMAGE_GEN_MODE } from '../../services/imageGen/modes.js';
import { buildComicPdf, PAGE_SIZES, DEFAULT_PAGE_SIZE } from '../../services/pipeline/comicPdf.js';
import { buildVolumePdf } from '../../services/pipeline/volumePdf.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Render-schema factory — every cover/back-cover render route shares the
// same shape (image-gen knobs + proof/final variant + useProofAsBase i2i),
// differing only in the script-field name. Four routes × ~16 fields each
// were a 60-line mirror before this factory; new fields now apply to all
// four call sites at once. `target` is the proof/final variant; the route
// param resolves the cover-vs-backCover slot.
//
// `seed` mirrors the page/panel render schemas so the shared image-gen
// drawer flows the same render settings into the cover —
// enqueueImageJob honors it via options.seed. `useProofAsBase` is honored by
// local (mflux `--image-path`) and codex (gpt-image-2 image-edit via the
// CLI's `-i <file>` flag); external SD-API has no i2i wiring and silently
// drops the init image at the dispatcher.
const makeCoverRenderSchema = (scriptField) => z.object({
  [scriptField]: z.string().max(8000).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX]).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  target: z.enum(COMIC_PAGE_VARIANTS).optional().default('proof'),
  useProofAsBase: z.boolean().optional().default(false),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

const comicCoverRenderSchema     = makeCoverRenderSchema('coverScript');
const comicBackCoverRenderSchema = makeCoverRenderSchema('backCoverScript');
const volumeCoverRenderSchema    = makeCoverRenderSchema('coverScript');
const volumeBackCoverRenderSchema = makeCoverRenderSchema('backCoverScript');

const volumeCoverConceptsSchema = z.object({
  commit: z.boolean().optional().default(false),
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(200).optional(),
});

const comicCoverConceptsSchema = z.object({
  target: z.enum(['cover', 'backCover', 'both']).optional().default('both'),
  commit: z.boolean().optional().default(false),
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(200).optional(),
});

// =====================
// Volume (season) covers — front + back illustration on the season record.
// Stored on series.seasons[].cover / .backCover, sanitized by sanitizeSeason,
// rendered by enqueueVolumeCover{,BackCover}, stamped on completion by
// seasonCoverFilenameHook. Compiled with all child issues into a trade-
// paperback PDF by the volume.pdf route below.
// =====================

router.post('/series/:id/seasons/:seasonId/cover-concepts/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(volumeCoverConceptsSchema, req.body ?? {});
  const result = await arcPlanner.generateVolumeCoverConcepts(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Cover-render factory — shared by the four cover-render routes (volume
// front/back + comic-issue front/back).
//
// Script-gate semantics: only update `script` when the body carried the
// field as a string — absent preserves, empty-string intentionally clears.
// Blur-save (PATCH stages/.../cover) owns the script field and races
// against render; writing the *resolved* value (which falls back to the
// persisted record's script when absent) would clobber a concurrent blur.
const buildCoverPatchFn = ({ slotField, scriptField, body, slotKey, slotRecord }) => (current) => {
  const currentSlot = current?.[slotField] || {};
  const nextSlot = { ...currentSlot, [slotKey]: slotRecord };
  if (typeof body[scriptField] === 'string') nextSlot.script = body[scriptField];
  return { [slotField]: nextSlot };
};

const makeCoverRenderHandler = ({
  schema, slotField, scriptField, enqueue, applyWrite, buildResponse,
}) => asyncHandler(async (req, res) => {
  const body = validateRequest(schema, req.body ?? {});
  const result = await enqueue(req, body).catch((err) => { throw mapServiceError(err); });

  const slotKey = slotKeyForVariant(result.variant);
  const slotRecord = buildRenderSlot({
    slotKey, jobId: result.jobId, prompt: result.prompt,
    width: body.width, height: body.height, fromProof: result.fromProof,
  });
  const computeFn = buildCoverPatchFn({ slotField, scriptField, body, slotKey, slotRecord });
  const writeResult = await applyWrite(req, computeFn)
    .catch((err) => { throw mapServiceError(err); });
  res.json(buildResponse({ result, writeResult, req }));
});

const buildVolumeCoverResponse = ({ result, writeResult: series, req }) => {
  const season = (series.seasons || []).find((s) => s.id === req.params.seasonId);
  return { ...result, season, series };
};

const updateVolumeSeason = (req, computeFn) =>
  seriesSvc.updateSeasonOnSeries(req.params.id, req.params.seasonId, computeFn);

const updateComicPagesStage = (req, computeFn) =>
  issuesSvc.updateStageWithLatest(req.params.id, 'comicPages', computeFn);

// Render the volume front cover. Persists the in-flight render slot onto
// season.cover via seriesSvc.updateSeasonOnSeries (queue-serialized) — the
// season-cover filename hook stamps the completed filename later.
// (Missing series / season surface as PIPELINE_SEASON_NOT_FOUND from
// enqueueVolumeCover's loadSeasonContext, mapped to 404 by mapServiceError.)
router.post('/series/:id/seasons/:seasonId/cover/render', makeCoverRenderHandler({
  schema: volumeCoverRenderSchema,
  slotField: 'cover',
  scriptField: 'coverScript',
  enqueue: (req, body) => enqueueVolumeCover(req.params.id, req.params.seasonId, body),
  applyWrite: updateVolumeSeason,
  buildResponse: buildVolumeCoverResponse,
}));

router.post('/series/:id/seasons/:seasonId/back-cover/render', makeCoverRenderHandler({
  schema: volumeBackCoverRenderSchema,
  slotField: 'backCover',
  scriptField: 'backCoverScript',
  enqueue: (req, body) => enqueueVolumeBackCover(req.params.id, req.params.seasonId, body),
  applyWrite: updateVolumeSeason,
  buildResponse: buildVolumeCoverResponse,
}));

// Compile a trade-paperback PDF: volume front → for each issue
// [issue front → issue pages → issue back] → volume back → optional colophon.
// 409 with ERR_NO_VOLUME_COVER when the season has no rendered front cover;
// 409 with ERR_NO_RENDERED_ISSUES when no issue has any rendered page yet.
router.get('/series/:id/seasons/:seasonId/volume.pdf', asyncHandler(async (req, res) => {
  const sizeRaw = typeof req.query.size === 'string' ? req.query.size : '';
  const size = PAGE_SIZES[sizeRaw] ? sizeRaw : DEFAULT_PAGE_SIZE;
  const includeColophon = req.query.colophon !== 'skip';
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
  schema: comicCoverRenderSchema,
  slotField: 'cover',
  scriptField: 'coverScript',
  enqueue: (req, body) => enqueueComicCover(req.params.id, body),
  applyWrite: updateComicPagesStage,
  buildResponse: ({ result, writeResult: { issue, stage } }) =>
    ({ ...result, cover: stage.cover, issue, stage }),
}));

// Render the comic-issue BACK cover. Same flow as the front-cover route;
// differs in the prompt (no masthead, explicit no-text negative) and the
// persisted slot (`stages.comicPages.backCover.{proofImage|finalImage}`).
router.post('/issues/:id/stages/comicPages/back-cover/render', makeCoverRenderHandler({
  schema: comicBackCoverRenderSchema,
  slotField: 'backCover',
  scriptField: 'backCoverScript',
  enqueue: (req, body) => enqueueComicBackCover(req.params.id, body),
  applyWrite: updateComicPagesStage,
  buildResponse: ({ result, writeResult: { issue, stage } }) =>
    ({ ...result, backCover: stage.backCover, issue, stage }),
}));

// Print-ready PDF export of a comic issue's rendered pages. Streams the
// assembled PDF straight to the response — no on-disk artifact, so a new
// render is always a fresh assembly. ?size= picks paper format
// (us-letter|a4|tabloid). 409 when the issue has no rendered cover/pages.
router.get('/issues/:id/comic.pdf', asyncHandler(async (req, res) => {
  const sizeRaw = typeof req.query.size === 'string' ? req.query.size : '';
  const size = PAGE_SIZES[sizeRaw] ? sizeRaw : DEFAULT_PAGE_SIZE;
  const includeCover = req.query.cover !== 'skip';
  const includeBackCover = req.query.backCover !== 'skip';
  const includeColophon = req.query.colophon !== 'skip';
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
