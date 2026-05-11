/**
 * Pipeline Routes
 *
 * Two resource scopes:
 *   /api/pipeline/series       — Series CRUD (the long-lived narrative bible)
 *   /api/pipeline/issues       — Issue/Episode CRUD + stage operations
 *
 *   GET    /series                              → Series[]
 *   POST   /series                              → Series
 *   GET    /series/:id                          → Series
 *   PATCH  /series/:id                          → Series
 *   DELETE /series/:id                          → { id }
 *   GET    /series/:id/issues                   → Issue[]
 *   POST   /series/:id/issues                   → Issue
 *   GET    /issues/:id                          → Issue
 *   PATCH  /issues/:id                          → Issue
 *   DELETE /issues/:id                          → { id }
 *   POST   /issues/:id/stages/:stageId/generate → { issue, stage, runId }
 *   POST   /issues/:id/stages/:stageId/visual   → { jobId, mode, prompt }
 *   POST   /issues/:id/auto-run-text            → { runId, alreadyRunning, sseUrl }
 *   GET    /issues/:id/auto-run-text/progress   → SSE (text/event-stream)
 *   POST   /issues/:id/auto-run-text/cancel     → { canceled }
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as seriesSvc from '../services/pipeline/series.js';
import * as issuesSvc from '../services/pipeline/issues.js';
import { generateStage } from '../services/pipeline/textStages.js';
import * as autoRunner from '../services/pipeline/autoRunner.js';
import { enqueueVisualImage } from '../services/pipeline/visualStages.js';
import { startEpisodeVideoForIssue, ERR_NO_STORYBOARDS } from '../services/pipeline/episodeVideo.js';
import { ASPECT_RATIOS, QUALITIES } from '../lib/creativeDirectorPresets.js';
import { extractScenes, SOURCE_KIND } from '../lib/sceneExtractor.js';
import { BIBLE_KIND } from '../lib/storyBible.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [seriesSvc.ERR_NOT_FOUND]: 404,
  [seriesSvc.ERR_VALIDATION]: 400,
  [issuesSvc.ERR_NOT_FOUND]: 404,
  [issuesSvc.ERR_VALIDATION]: 400,
  [ERR_NO_STORYBOARDS]: 400,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

// ---- Series schemas ----

// Bible entries are sanitized server-side via the canonical shape in
// `server/lib/storyBible.js`; the route schema is intentionally permissive
// (max length only) so additive fields don't require a schema migration.
const bibleEntrySchema = z.record(z.string(), z.any());

const characterSchema = z.object({
  id: z.string().trim().max(80).optional(),
  name: z.string().trim().min(1).max(seriesSvc.CHARACTER_NAME_MAX),
  // Back-compat: pre-DRY shape used `description`. Both fields are accepted
  // and the canonical sanitizer normalizes them to `physicalDescription`.
  description: z.string().trim().max(seriesSvc.CHARACTER_DESCRIPTION_MAX).optional(),
  physicalDescription: z.string().trim().max(seriesSvc.CHARACTER_DESCRIPTION_MAX).optional(),
  aliases: z.array(z.string().trim().min(1).max(100)).max(12).optional(),
  role: z.string().trim().max(200).optional(),
  personality: z.string().trim().max(2000).optional(),
  background: z.string().trim().max(2000).optional(),
  notes: z.string().trim().max(4000).optional(),
  imageRefs: z.array(z.string().trim().min(1).max(seriesSvc.IMAGE_REF_MAX))
    .max(seriesSvc.IMAGE_REFS_PER_CHARACTER_MAX).optional(),
});

const seriesCreateSchema = z.object({
  name: z.string().trim().min(1).max(seriesSvc.NAME_MAX),
  logline: z.string().trim().max(seriesSvc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(seriesSvc.PREMISE_MAX).optional().default(''),
  worldId: z.string().trim().max(seriesSvc.WORLD_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(seriesSvc.WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  characters: z.array(characterSchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  settings: z.array(bibleEntrySchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  objects: z.array(bibleEntrySchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional().default(''),
  targetFormat: z.enum(seriesSvc.TARGET_FORMATS).optional(),
  issueCountTarget: z.number().int().min(0).max(seriesSvc.ISSUE_COUNT_TARGET_MAX).optional(),
});

const seriesPatchSchema = z.object({
  name: z.string().trim().min(1).max(seriesSvc.NAME_MAX).optional(),
  logline: z.string().trim().max(seriesSvc.LOGLINE_MAX).optional(),
  premise: z.string().trim().max(seriesSvc.PREMISE_MAX).optional(),
  worldId: z.string().trim().max(seriesSvc.WORLD_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(seriesSvc.WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  characters: z.array(characterSchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  settings: z.array(bibleEntrySchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  objects: z.array(bibleEntrySchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional(),
  targetFormat: z.enum(seriesSvc.TARGET_FORMATS).optional(),
  issueCountTarget: z.number().int().min(0).max(seriesSvc.ISSUE_COUNT_TARGET_MAX).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

// ---- Issue schemas ----

const issueCreateSchema = z.object({
  title: z.string().trim().min(1).max(issuesSvc.TITLE_MAX),
  number: z.number().int().min(1).max(9999).optional(),
});

const stageInputSchema = z.object({
  status: z.enum(issuesSvc.STAGE_STATUSES).optional(),
  input: z.string().max(issuesSvc.STAGE_INPUT_MAX).optional(),
  output: z.string().max(issuesSvc.STAGE_OUTPUT_MAX).optional(),
  errorMessage: z.string().max(issuesSvc.STAGE_NOTES_MAX).optional(),
});

// Visual stage records also accept pages/scenes/cdProjectId/videoPath — those
// are arbitrary structured artifacts written by the visual UI. Keep the
// validation light here so the artifact shape can evolve without a schema
// migration; the service-level sanitizer caps array length.
const visualStageInputSchema = stageInputSchema.extend({
  pages: z.array(z.any()).max(200).optional(),
  scenes: z.array(z.any()).max(200).optional(),
  cdProjectId: z.string().trim().max(64).nullable().optional(),
  videoPath: z.string().trim().max(1000).nullable().optional(),
});

const issuePatchSchema = z.object({
  title: z.string().trim().min(1).max(issuesSvc.TITLE_MAX).optional(),
  number: z.number().int().min(1).max(9999).optional(),
  status: z.enum(issuesSvc.ISSUE_STATUSES).optional(),
  // Use visualStageInputSchema as the union arm so visual-stage payloads keep
  // their `scenes` / `pages` / `cdProjectId` / `videoPath` fields. The schema
  // is a superset of stageInputSchema (those four are optional additions), so
  // text-stage patches still validate. Z.union picks the first schema that
  // succeeds — stageInputSchema first would silently strip the visual fields.
  stages: z.record(z.string(), z.union([visualStageInputSchema, stageInputSchema])).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const generateSchema = z.object({
  seedInput: z.string().max(issuesSvc.STAGE_INPUT_MAX).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

const visualGenerateSchema = z.object({
  description: z.string().trim().min(1).max(8000),
  // Matched against the series settings bible when present.
  slugline: z.string().trim().max(200).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum(['local', 'codex']).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
});

const episodeVideoSchema = z.object({
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  quality: z.enum(QUALITIES).optional(),
  modelId: z.string().trim().max(64).optional(),
  force: z.boolean().optional(),
});

// Source for scene extraction: which text stage to read from (`prose` →
// granular paragraph-grain breakdown via `writers-room-script`; `tvScript`
// → slugline-grain parse via `pipeline-extract-scenes`). `force` overrides
// the "you have N hand-curated scenes already" guard.
// Enum values match `SOURCE_KIND` verbatim so the route forwards `body.from`
// straight through — same string also names the issue's text stage.
const extractScenesSchema = z.object({
  from: z.enum([SOURCE_KIND.PROSE, SOURCE_KIND.TV_SCRIPT]).optional().default(SOURCE_KIND.TV_SCRIPT),
  providerOverride: z.string().trim().max(80).optional(),
  force: z.boolean().optional(),
});

// Source: `issueId` (pulls `stages.prose.output`) OR explicit `corpus` text.
// `parallel: true` runs the three bible kinds concurrently (~3× wall-clock
// speedup on HTTP-API providers like OpenAI/Anthropic/LM Studio HTTP).
// Default stays sequential — safe for CLI providers that serialize at the
// session anyway (codex / claude-code / gemini-cli).
const extractBibleSchema = z.object({
  kinds: z.array(z.enum([BIBLE_KIND.CHARACTER, BIBLE_KIND.SETTING, BIBLE_KIND.OBJECT]))
    .min(1).max(3).optional()
    .default([BIBLE_KIND.CHARACTER, BIBLE_KIND.SETTING, BIBLE_KIND.OBJECT]),
  issueId: z.string().trim().max(64).optional(),
  corpus: z.string().min(1).max(issuesSvc.STAGE_OUTPUT_MAX).optional(),
  providerOverride: z.string().trim().max(80).optional(),
  parallel: z.boolean().optional(),
}).refine((p) => p.issueId || p.corpus, { message: 'extract requires either `issueId` or `corpus`' });

const autoRunSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  force: z.boolean().optional(),
  // Optional opt-in to extend the auto-run past text stages: kicks off the
  // episodeVideo handoff to Creative Director once scripts are done. Burns
  // GPU minutes, so default is off.
  includeVideo: z.boolean().optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  quality: z.enum(QUALITIES).optional(),
  modelId: z.string().trim().max(64).optional(),
});

// =====================
// Series routes
// =====================

router.get('/series', asyncHandler(async (_req, res) => {
  res.json(await seriesSvc.listSeries());
}));

router.post('/series', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesCreateSchema, req.body ?? {});
  res.status(201).json(await seriesSvc.createSeries(body));
}));

router.get('/series/:id', asyncHandler(async (req, res) => {
  const s = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(s);
}));

router.patch('/series/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesPatchSchema, req.body ?? {});
  const s = await seriesSvc.updateSeries(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.json(s);
}));

router.post('/series/:id/extract-bible', asyncHandler(async (req, res) => {
  const body = validateRequest(extractBibleSchema, req.body ?? {});
  // Validate series exists up front so a typo returns 404 instead of bubbling
  // out of the service-layer call below.
  const series = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });

  let corpus = (body.corpus || '').trim();
  if (!corpus) {
    const issue = await issuesSvc.getIssue(body.issueId).catch((err) => { throw mapServiceError(err); });
    if (issue.seriesId !== series.id) {
      throw new ServerError('Issue does not belong to this series', { status: 400, code: 'PIPELINE_ISSUE_SERIES_MISMATCH' });
    }
    corpus = (issue.stages?.prose?.output || '').trim();
    if (!corpus) {
      throw new ServerError('Issue has no prose to extract from — generate the prose stage first', {
        status: 400, code: 'PIPELINE_NO_PROSE_FOR_EXTRACTION',
      });
    }
  }

  // Delegate the extract → merge → patch chain to the service layer so
  // mergeExtractedBible stays a service-internal concern.
  const result = await seriesSvc.extractAndMergeIntoSeries(series.id, {
    kinds: body.kinds,
    corpus,
    parallel: body.parallel,
    providerOverride: body.providerOverride,
  }).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.delete('/series/:id', asyncHandler(async (req, res) => {
  const r = await seriesSvc.deleteSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

router.get('/series/:id/issues', asyncHandler(async (req, res) => {
  // Validate the series exists so a typo returns 404 instead of [] (less
  // confusing for the UI).
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await issuesSvc.listIssues({ seriesId: req.params.id }));
}));

router.post('/series/:id/issues', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(issueCreateSchema, req.body ?? {});
  const created = await issuesSvc.createIssue({ ...body, seriesId: req.params.id });
  res.status(201).json(created);
}));

// =====================
// Issue routes
// =====================

router.get('/issues/:id', asyncHandler(async (req, res) => {
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(issue);
}));

router.patch('/issues/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(issuePatchSchema, req.body ?? {});
  const issue = await issuesSvc.updateIssue(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.json(issue);
}));

router.delete('/issues/:id', asyncHandler(async (req, res) => {
  const r = await issuesSvc.deleteIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

// =====================
// Stage operations
// =====================

router.post('/issues/:id/stages/:stageId/generate', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!issuesSvc.TEXT_STAGE_IDS.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" is not generatable via text-LLM. Use the /visual endpoint for image stages.`,
      { status: 400, code: 'PIPELINE_NON_TEXT_STAGE' },
    );
  }
  const body = validateRequest(generateSchema, req.body ?? {});
  const result = await generateStage(id, stageId, body).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Auto-fill stages.storyboards.scenes[] from a text stage. Reads the issue's
// prose (paragraph-grain) or tvScript (slugline-grain) output, runs the
// shared scene extractor, and replaces stages.storyboards.scenes with the
// result mapped to the storyboards UI shape (visualPrompt → description).
router.post('/issues/:id/stages/storyboards/extract-scenes', asyncHandler(async (req, res) => {
  const body = validateRequest(extractScenesSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });

  const sourceKind = body.from;
  const source = (issue.stages?.[sourceKind]?.output || '').trim();
  if (!source) {
    throw new ServerError(
      `Cannot extract scenes — issue's ${sourceKind} stage is empty`,
      { status: 400, code: 'PIPELINE_NO_SOURCE_FOR_SCENE_EXTRACT' },
    );
  }

  const existing = Array.isArray(issue.stages?.storyboards?.scenes) ? issue.stages.storyboards.scenes : [];
  if (existing.length > 0 && !body.force) {
    throw new ServerError(
      `Storyboards already has ${existing.length} scene${existing.length === 1 ? '' : 's'} — pass { force: true } to replace`,
      { status: 409, code: 'PIPELINE_STORYBOARDS_NOT_EMPTY' },
    );
  }

  const result = await extractScenes({
    source,
    sourceKind,
    characters: series.characters || [],
    settings: series.settings || [],
    objects: series.objects || [],
    work: { title: issue.title, kind: 'tv-episode' },
    series: { name: series.name, styleNotes: series.styleNotes },
    issue: { number: issue.number, title: issue.title },
    providerOverride: body.providerOverride,
    tag: `pipeline-storyboards-extract-${sourceKind}`,
  });

  // Adapt canonical scene shape to the pipeline storyboards UI shape: alias
  // `visualPrompt → description` (the textarea binding) and reset the per-scene
  // image-gen job fields. Rich fields (heading/summary/dialogue/...) ride along.
  const storyboardScenes = result.extracted.scenes.map((s) => ({
    ...s,
    description: s.visualPrompt || '',
    imageJobId: null,
    prompt: null,
  }));
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(issue.id, 'storyboards', {
    status: storyboardScenes.length ? 'ready' : 'empty',
    scenes: storyboardScenes,
    lastRunId: result.runId,
    errorMessage: '',
  });

  res.json({
    issue: updatedIssue,
    stage,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
    sceneCount: storyboardScenes.length,
    sourceKind,
  });
}));

router.post('/issues/:id/stages/:stageId/visual', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!issuesSvc.VISUAL_STAGE_IDS.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" is not a visual stage. Use /generate for text-LLM stages.`,
      { status: 400, code: 'PIPELINE_NON_VISUAL_STAGE' },
    );
  }
  if (stageId === 'episodeVideo') {
    const body = validateRequest(episodeVideoSchema, req.body ?? {});
    const result = await startEpisodeVideoForIssue(id, body).catch((err) => { throw mapServiceError(err); });
    res.json(result);
    return;
  }
  const body = validateRequest(visualGenerateSchema, req.body ?? {});
  const result = await enqueueVisualImage(id, stageId, body).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// =====================
// Auto-run text chain
// =====================

router.post('/issues/:id/auto-run-text', asyncHandler(async (req, res) => {
  const body = validateRequest(autoRunSchema, req.body ?? {});
  // Validate the issue exists before kicking off the runner so a bad id
  // returns 404 instead of a half-started run.
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = await autoRunner.startAutoRunTextStages(req.params.id, body);
  res.json({
    ...result,
    sseUrl: `/api/pipeline/issues/${req.params.id}/auto-run-text/progress`,
  });
}));

router.get('/issues/:id/auto-run-text/progress', (req, res) => {
  const attached = autoRunner.attachClient(req.params.id, res);
  if (!attached) {
    res.status(404).json({ error: 'No active auto-run for this issue' });
  }
});

router.post('/issues/:id/auto-run-text/cancel', asyncHandler(async (req, res) => {
  const canceled = autoRunner.cancelAutoRun(req.params.id);
  res.json({ canceled });
}));

export default router;
