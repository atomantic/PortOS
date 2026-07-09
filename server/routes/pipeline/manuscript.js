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
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as arcPlanner from '../../services/pipeline/arcPlanner.js';
import * as manuscriptReview from '../../services/pipeline/manuscriptReview.js';
import * as manuscriptFix from '../../services/pipeline/manuscriptFix.js';
import * as applyCuts from '../../services/pipeline/applyCuts.js';
import * as completenessRunner from '../../services/pipeline/manuscriptCompletenessRunner.js';
import { getReviewWithStaleness } from '../../services/pipeline/editorial/checkRunner.js';
import { recordTrendSnapshot } from '../../services/pipeline/editorialScore.js';
import { readReadinessGate, mergeSeverityWeights } from '../../lib/editorial/index.js';
import { getSettings } from '../../services/settings.js';
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
  // Why a dismissal was made (#1605) — `false-positive` flags a broken check;
  // `null` clears the reason back to a plain "won't fix" dismiss. Validated
  // against the same source the service sanitizes from.
  dismissReason: z.enum(manuscriptReview.DISMISS_REASONS).nullable().optional(),
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

const manuscriptReformatSchema = z.object({
  stageId: z.enum(seriesSvc.MANUSCRIPT_TYPES),
  content: z.string().max(issuesSvc.STAGE_OUTPUT_MAX),
  ...providerOverrideShape,
});

// Adversarial cuts — preview and apply (#2168).
const manuscriptCutsSchema = z.object({
  // Which comment ids to apply cuts from. If empty, applies all eligible open cuts.
  commentIds: z.array(z.string().min(1).max(120)).max(100).optional(),
  // Filter by cut types. Defaults to SAFE_CUT_TYPES (OVER-EXPLAIN, REDUNDANT).
  allowTypes: z.array(z.enum(applyCuts.CUT_TYPES)).max(6).optional(),
  // Whether to only allow safe cut types.
  safeTypesOnly: z.boolean().optional(),
});

// Manuscript-completeness editor pass — categorized "finish the draft"
// suggestions read from the actual drafted script (not synopses). Advisory.
router.post('/series/:id/manuscript/completeness', asyncHandler(async (req, res) => {
  const series = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptCompletenessSchema, req.body ?? {});
  const result = await arcPlanner.analyzeManuscriptCompleteness(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  // Persist findings as a Word-style comment set so the manuscript editor can
  // work through them across reloads. `issues` stays in the response for the
  // existing ArcHeader caller — the editor reads the merged `review`.
  const review = await manuscriptReview.seedReviewFromFindings(req.params.id, result.issues, { runId: result.runId, mode: body.mode })
    .catch((err) => { throw mapServiceError(err); });
  // Revision-trend snapshot (#1316): this completeness pass is a revision
  // boundary. Best-effort — never fail the request on a ledger-write error.
  const gate = readReadinessGate(await getSettings().catch(() => null)) || undefined;
  // Series severity-weight override (#1616) so a persisted trend score matches
  // the live computeHealth score the UI shows.
  const weights = mergeSeverityWeights(series?.severityWeights);
  await recordTrendSnapshot(req.params.id, { runId: result.runId, gate, weights, comments: review.comments })
    .catch((err) => { console.error(`⚠️ editorial trend snapshot failed — series=${String(req.params.id).slice(0, 12)} ${err.message}`); });
  res.json({ ...result, review });
}));

// Streamed completeness review — backs the "generate edits for every finding"
// option. Kicks off the runner (which streams per-chunk progress over SSE, then
// seeds the review with pre-attached fixes) and returns the runId + SSE url. The
// client re-fetches the review on the terminal `complete` frame.
router.post('/series/:id/manuscript/completeness/stream', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptCompletenessSchema, req.body ?? {});
  // The streamed runner always generates per-finding edits (that's its reason to
  // exist) — no `withEdits` knob; the sync /completeness route stays findings-only.
  const result = await completenessRunner.startCompletenessReview(req.params.id, {
    providerOverride: body.providerOverride,
    modelOverride: body.modelOverride,
    mode: body.mode,
  });
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/manuscript/completeness/progress`,
  });
}));

router.get('/series/:id/manuscript/completeness/progress', (req, res) => {
  const attached = completenessRunner.attachClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active completeness review for this series', { status: 404 });
  }
});

// Lightweight probe so a (re)mounting client can re-attach to an in-flight run.
router.get('/series/:id/manuscript/completeness/status', (req, res) => {
  res.json({ active: completenessRunner.isCompletenessReviewActive(req.params.id) });
});

router.post('/series/:id/manuscript/completeness/cancel', asyncHandler(async (req, res) => {
  const canceled = completenessRunner.cancelCompletenessReview(req.params.id);
  res.json({ canceled });
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
  // Annotates each editorial-check finding with a `stale` flag when its analyzed
  // content has drifted since the check ran (#1345); completeness-only reviews
  // pass through untouched.
  res.json(await getReviewWithStaleness(req.params.id));
}));

// Resolve a finding by its (series-agnostic) comment id alone → the owning
// series + comment, so a deep-link carrying only a commentId can open the
// editor without the user first picking a series (#1608). 404 when no series
// review contains the id (e.g. the finding was dismissed-then-GC'd or the link
// is stale).
router.get('/findings/:commentId/locate', asyncHandler(async (req, res) => {
  const located = await manuscriptReview.locateComment(req.params.commentId);
  if (!located) throw new ServerError('Finding not found', { status: 404, code: 'PIPELINE_FINDING_NOT_FOUND' });
  res.json(located);
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

// Undo a previously-accepted fix: restore the captured pre-edit text and re-open
// the finding (#1609). No body — the authoritative snapshot lives on the comment.
router.post('/series/:id/manuscript/review/comments/:commentId/undo', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = await manuscriptFix.undoManuscriptFix(req.params.id, { commentId: req.params.commentId })
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

// AI reformat of manuscript text — repair PDF/paste artifacts (wrapping, split
// drop-caps, orphaned quotes) WITHOUT changing words. Compute-only: it returns
// the cleaned `{ text, changed }` and does NOT persist — the client sends its
// live (possibly unsaved) content and owns the save, so unsaved edits aren't
// clobbered and a mid-call edit can skip the write. An integrity guard in the
// service discards (400s) any result that altered the wording.
router.post('/series/:id/manuscript/reformat', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const { content, ...opts } = validateRequest(manuscriptReformatSchema, req.body ?? {});
  const result = await manuscriptFix.reformatManuscriptStageText(content, opts)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Adversarial cuts (#2168) — batch application of cut-type findings.
// ---------------------------------------------------------------------------

// Preview cuts — dry-run that returns before/after diffs without applying.
router.post('/series/:id/manuscript/cuts/preview', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptCutsSchema, req.body ?? {});
  const review = await manuscriptReview.getReview(req.params.id);
  // Filter to open cut-type comments.
  let cuts = applyCuts.filterCutComments(review.comments);
  // If specific comment ids requested, filter to those.
  if (Array.isArray(body.commentIds) && body.commentIds.length > 0) {
    const wanted = new Set(body.commentIds);
    cuts = cuts.filter((c) => wanted.has(c.id));
  }
  const opts = {
    safeTypesOnly: body.safeTypesOnly !== false,
    allowTypes: Array.isArray(body.allowTypes) ? body.allowTypes : applyCuts.SAFE_CUT_TYPES,
  };
  const result = await applyCuts.previewCuts(req.params.id, cuts, opts)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Apply cuts — writes through the serialized stage-write path with snapshots.
router.post('/series/:id/manuscript/cuts/apply', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(manuscriptCutsSchema, req.body ?? {});
  const review = await manuscriptReview.getReview(req.params.id);
  // Filter to open cut-type comments.
  let cuts = applyCuts.filterCutComments(review.comments);
  // If specific comment ids requested, filter to those.
  if (Array.isArray(body.commentIds) && body.commentIds.length > 0) {
    const wanted = new Set(body.commentIds);
    cuts = cuts.filter((c) => wanted.has(c.id));
  }
  const opts = {
    safeTypesOnly: body.safeTypesOnly !== false,
    allowTypes: Array.isArray(body.allowTypes) ? body.allowTypes : applyCuts.SAFE_CUT_TYPES,
  };
  const result = await applyCuts.applyCuts(req.params.id, cuts, opts)
    .catch((err) => { throw mapServiceError(err); });
  // Mark applied cuts as accepted in the review.
  const appliedSections = new Set(result.sections.map((s) => `${s.issueId}:${s.stageId}`));
  const appliedCuts = cuts.filter((c) => {
    // A cut was applied if it wasn't in the refusedDetails.
    const refused = result.refusedDetails.some((r) => r.quote === c.anchorQuote);
    if (refused) return false;
    // And its section was updated.
    const key = c.issueId && c.stageId ? `${c.issueId}:${c.stageId}` : null;
    return key ? appliedSections.has(key) : true;
  });
  // Auto-accept applied cuts.
  for (const c of appliedCuts) {
    await manuscriptReview.updateComment(req.params.id, c.id, { status: 'accepted' })
      .catch((err) => console.warn(`⚠️ applyCuts: failed to mark comment ${c.id} accepted: ${err.message}`));
  }
  res.json({ ...result, acceptedCount: appliedCuts.length });
}));

export default router;
