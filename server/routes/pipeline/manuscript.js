/**
 * Pipeline manuscript routes — the completeness ("finish the draft") editor
 * pass plus the manuscript editor: full series manuscript + persisted
 * editorial comments. The "manuscript" is virtual: one chosen stage per issue
 * (comicScript ▸ teleplay ▸ prose) concatenated in story order. Edits target
 * a specific issue+stage; comments persist in
 * data/pipeline-series/{id}/manuscript-review.json.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as arcPlanner from '../../services/pipeline/arcPlanner.js';
import * as manuscriptReview from '../../services/pipeline/manuscriptReview.js';
import * as manuscriptFix from '../../services/pipeline/manuscriptFix.js';
import { mapServiceError, providerOverrideShape } from './shared.js';

const router = Router();

// Manuscript-completeness ("finish the draft") editor pass — override shape plus
// the re-run mode: 'merge' (default) leaves prior comments as-is and appends new
// findings; 'fresh' also auto-dismisses open comments this pass no longer finds
// (accepted/dismissed untouched). See seedReviewFromFindings.
const manuscriptCompletenessSchema = z.object({
  ...providerOverrideShape,
  mode: z.enum(manuscriptReview.REVIEW_RUN_MODES).optional(),
});

// Manuscript editor — review comment operations.
const manuscriptFixGenerateSchema = z.object(providerOverrideShape);
const manuscriptFixEditSchema = z.object({
  issueNumber: z.number().int().nullable().optional(),
  issueId: z.string().min(1).max(120).nullable().optional(),
  stageId: z.enum(seriesSvc.MANUSCRIPT_TYPES).nullable().optional(),
  find: z.string().min(1).max(issuesSvc.STAGE_OUTPUT_MAX),
  replace: z.string().max(issuesSvc.STAGE_OUTPUT_MAX),
});
const manuscriptFixAcceptSchema = z.object({
  find: z.string().min(1).max(issuesSvc.STAGE_OUTPUT_MAX).optional(),
  replace: z.string().max(issuesSvc.STAGE_OUTPUT_MAX).optional(),
  edits: z.array(manuscriptFixEditSchema).max(20).optional(),
}).refine((v) => (Array.isArray(v.edits) && v.edits.length > 0) || !!v.find, {
  message: 'Provide find/replace or at least one edit',
}).refine((v) => !v.find || typeof v.replace === 'string', {
  path: ['replace'],
  message: 'replace is required when find is provided',
});
// Comment PATCH: status flip and/or attach/clear a fix. `.strict()` rejects
// stray keys; `fix` nullable so an explicit clear is distinguishable from absent.
const manuscriptCommentPatchSchema = z.object({
  status: z.enum(['open', 'accepted', 'dismissed']).optional(),
  fix: z.object({
    find: z.string().max(issuesSvc.STAGE_OUTPUT_MAX).optional(),
    replace: z.string().max(issuesSvc.STAGE_OUTPUT_MAX).optional(),
    fuzzy: z.boolean().optional(),
    edits: z.array(manuscriptFixEditSchema.extend({
      title: z.string().max(200).optional(),
      note: z.string().max(1000).optional(),
      fuzzy: z.boolean().optional(),
    })).max(20).optional(),
  }).refine((v) => !!v.find || !!v.replace || (Array.isArray(v.edits) && v.edits.length > 0), {
    message: 'Fix must include find/replace or edits',
  }).nullable().optional(),
}).strict();
// Versioned free-text section save — writes one issue's manuscript stage.
const manuscriptSectionSaveSchema = z.object({
  stageId: z.enum(seriesSvc.MANUSCRIPT_TYPES),
  output: z.string().max(issuesSvc.STAGE_OUTPUT_MAX),
});

// Manuscript-completeness editor pass — categorized "finish the draft"
// suggestions read from the actual drafted script (not synopses). Advisory.
router.post('/series/:id/manuscript/completeness', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptCompletenessSchema, req.body ?? {});
  const result = await arcPlanner.analyzeManuscriptCompleteness(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  // Persist findings as a Word-style comment set so the manuscript editor can
  // work through them across reloads. `issues` stays in the response for the
  // existing ArcHeader caller — the editor reads the merged `review`.
  const review = await manuscriptReview.seedReviewFromFindings(req.params.id, result.issues, { runId: result.runId, mode: body.mode })
    .catch((err) => { throw mapServiceError(err); });
  res.json({ ...result, review });
}));

// Full series manuscript in a chosen format (prose / teleplay / comic script).
// `?type=` selects the format; absent → the series' pinned primaryManuscriptType,
// else the auto-detected dominant format. Returns the requested format's
// sections plus the metadata the editor's format switcher needs.
router.get('/series/:id/manuscript', asyncHandler(async (req, res) => {
  const series = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const { sectionsByType, availableTypes, detectedPrimary } = await arcPlanner.collectManuscriptByType(req.params.id);
  // Resolve the primary (source-of-truth) format: pinned bible value wins, then
  // detection, then a stable default so the editor always has something to show.
  const primaryStageId = series.primaryManuscriptType || detectedPrimary || 'prose';
  const requested = seriesSvc.MANUSCRIPT_TYPES.includes(req.query.type) ? req.query.type : null;
  const viewType = requested || primaryStageId;
  res.json({
    sections: sectionsByType[viewType] || [],
    viewType,
    primaryStageId,
    pinnedPrimary: series.primaryManuscriptType || null,
    availableTypes,
  });
}));

router.get('/series/:id/manuscript/review', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await manuscriptReview.getReview(req.params.id));
}));

router.patch('/series/:id/manuscript/review/comments/:commentId', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptCommentPatchSchema, req.body ?? {});
  const comment = await manuscriptReview.updateComment(req.params.id, req.params.commentId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json({ comment });
}));

// Generate one or more anchored fix edits for one comment (does not apply them).
router.post('/series/:id/manuscript/review/comments/:commentId/fix', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptFixGenerateSchema, req.body ?? {});
  const result = await manuscriptFix.generateManuscriptFix(req.params.id, { commentId: req.params.commentId, ...body })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Apply selected, optionally edited fix edits into stage output + mark accepted.
router.post('/series/:id/manuscript/review/comments/:commentId/accept', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptFixAcceptSchema, req.body ?? {});
  const result = await manuscriptFix.acceptManuscriptFix(req.params.id, { commentId: req.params.commentId, ...body })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Versioned free-text save of one manuscript section (snapshots the prior text
// into history so the edit is revertible). Revert reuses the stage-restore route
// (POST /issues/:id/stages/:stageId/restore).
router.put('/series/:id/manuscript/sections/:issueId', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptSectionSaveSchema, req.body ?? {});
  const result = await manuscriptFix.saveManuscriptSection(req.params.id, { issueId: req.params.issueId, ...body })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
