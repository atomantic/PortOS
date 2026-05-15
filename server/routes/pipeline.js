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
import {
  validateRequest,
  characterBibleCreateSchema,
  settingBibleCreateSchema,
  objectBibleCreateSchema,
} from '../lib/validation.js';
import * as seriesSvc from '../services/pipeline/series.js';
import * as issuesSvc from '../services/pipeline/issues.js';
import * as seasonsSvc from '../services/pipeline/seasons.js';
import * as arcPlanner from '../services/pipeline/arcPlanner.js';
import { generateStage } from '../services/pipeline/textStages.js';
import * as autoRunner from '../services/pipeline/autoRunner.js';
import {
  enqueueVisualImage,
  enqueueVisualComicPage,
  enqueueComicCover,
  enqueueStoryboardSceneVideo,
  refineComicPanelPrompt,
  refineStoryboardScenePrompt,
} from '../services/pipeline/visualStages.js';
import { refineCharacterDescription } from '../services/pipeline/nounRefine.js';
import { startEpisodeVideoForIssue, ERR_NO_STORYBOARDS } from '../services/pipeline/episodeVideo.js';
import { ASPECT_RATIOS, QUALITIES } from '../lib/creativeDirectorPresets.js';
import { extractScenes, SOURCE_KIND } from '../lib/sceneExtractor.js';
import { parseComicScript } from '../lib/comicScriptParser.js';
import {
  LENGTH_PROFILE_NAMES,
  CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX,
} from '../lib/issueLength.js';
import { llmSchema } from './universeBuilder.js';
import { BIBLE_KIND } from '../lib/storyBible.js';
import { ARC_LIMITS, ARC_STATUSES, SEASON_STATUSES } from '../lib/storyArc.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [seriesSvc.ERR_NOT_FOUND]: 404,
  [seriesSvc.ERR_VALIDATION]: 400,
  [issuesSvc.ERR_NOT_FOUND]: 404,
  [issuesSvc.ERR_VALIDATION]: 400,
  [seasonsSvc.ERR_NOT_FOUND]: 404,
  [seasonsSvc.ERR_VALIDATION]: 400,
  [seasonsSvc.ERR_REASSIGN_TARGET]: 400,
  [arcPlanner.ERR_VALIDATION]: 400,
  [ERR_NO_STORYBOARDS]: 400,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

// ---- Series schemas ----

// Bible entry shape is owned by the canonical schemas in `server/lib/validation.js`
// (re-exports of the Writers Room character/setting/object create-schemas). The
// Pipeline extends them here with its own back-compat fields and uses
// `.passthrough()` so canonical sanitizer-emitted fields (`evidence`,
// `firstAppearance`, `source`, `createdAt`, `updatedAt`, `missingFromProse`)
// round-trip cleanly when the client re-saves an existing series. Final
// enforcement lives in the sanitizer in `server/lib/storyBible.js`.
const characterSchema = characterBibleCreateSchema.extend({
  id: z.string().trim().max(80).optional(),
  // Back-compat: pre-DRY shape used `description`. Both fields are accepted
  // and the canonical sanitizer normalizes them to `physicalDescription`.
  description: z.string().trim().max(seriesSvc.CHARACTER_DESCRIPTION_MAX).optional(),
  // Pipeline-only image refs (not present on the writers-room shape).
  imageRefs: z.array(z.string().trim().min(1).max(seriesSvc.IMAGE_REF_MAX))
    .max(seriesSvc.IMAGE_REFS_PER_CHARACTER_MAX).optional(),
  // Pipeline preserves a looser `notes` cap (4000) than the writers-room
  // base (2000) — overriding here so user-facing limits don't tighten.
  notes: z.string().trim().max(4000).optional(),
}).passthrough();

const settingSchema = settingBibleCreateSchema.extend({
  id: z.string().trim().max(80).optional(),
}).passthrough();

const objectSchema = objectBibleCreateSchema.extend({
  id: z.string().trim().max(80).optional(),
}).passthrough();

// Arc + Season — phase 2 of Story Arc Planning. The arc lives on the series
// record itself; seasons get their own resource so the route layer can take
// per-record CRUD without forcing the caller to PATCH the whole series.
const arcSchema = z.object({
  logline: z.string().trim().max(ARC_LIMITS.LOGLINE_MAX).optional().default(''),
  summary: z.string().trim().max(ARC_LIMITS.SUMMARY_MAX).optional().default(''),
  protagonistArc: z.string().trim().max(ARC_LIMITS.PROTAGONIST_ARC_MAX).optional().default(''),
  themes: z.array(z.string().trim().min(1).max(ARC_LIMITS.THEME_MAX))
    .max(ARC_LIMITS.THEMES_PER_ARC_MAX).optional(),
  status: z.enum(ARC_STATUSES).optional(),
});

const seasonSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  number: z.number().int().min(0).max(ARC_LIMITS.SEASON_NUMBER_MAX).optional(),
  title: z.string().trim().max(ARC_LIMITS.SEASON_TITLE_MAX).optional(),
  logline: z.string().trim().max(ARC_LIMITS.SEASON_LOGLINE_MAX).optional(),
  synopsis: z.string().trim().max(ARC_LIMITS.SEASON_SYNOPSIS_MAX).optional(),
  episodeCountTarget: z.number().int().min(0).max(ARC_LIMITS.SEASON_EPISODE_COUNT_MAX).optional(),
  themes: z.array(z.string().trim().min(1).max(ARC_LIMITS.THEME_MAX))
    .max(ARC_LIMITS.THEMES_PER_ARC_MAX).optional(),
  endingHook: z.string().trim().max(ARC_LIMITS.SEASON_ENDING_HOOK_MAX).optional(),
  status: z.enum(SEASON_STATUSES).optional(),
}).passthrough();

const seriesCreateSchema = z.object({
  name: z.string().trim().min(1).max(seriesSvc.NAME_MAX),
  logline: z.string().trim().max(seriesSvc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(seriesSvc.PREMISE_MAX).optional().default(''),
  universeId: z.string().trim().max(seriesSvc.UNIVERSE_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(seriesSvc.WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  characters: z.array(characterSchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  settings: z.array(settingSchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  objects: z.array(objectSchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional().default(''),
  targetFormat: z.enum(seriesSvc.TARGET_FORMATS).optional(),
  issueCountTarget: z.number().int().min(0).max(seriesSvc.ISSUE_COUNT_TARGET_MAX).optional(),
  llm: llmSchema,
});

const seriesPatchSchema = z.object({
  name: z.string().trim().min(1).max(seriesSvc.NAME_MAX).optional(),
  logline: z.string().trim().max(seriesSvc.LOGLINE_MAX).optional(),
  premise: z.string().trim().max(seriesSvc.PREMISE_MAX).optional(),
  universeId: z.string().trim().max(seriesSvc.UNIVERSE_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(seriesSvc.WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  characters: z.array(characterSchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  settings: z.array(settingSchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  objects: z.array(objectSchema).max(seriesSvc.BIBLE_ENTRIES_PER_SERIES_MAX).optional(),
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional(),
  targetFormat: z.enum(seriesSvc.TARGET_FORMATS).optional(),
  issueCountTarget: z.number().int().min(0).max(seriesSvc.ISSUE_COUNT_TARGET_MAX).optional(),
  llm: llmSchema,
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

// Season-resource schemas: dedicated CRUD on a sibling resource so the
// client can edit one season without resending the whole series patch.
const seasonCreateSchema = seasonSchema.refine(
  (p) => (p.title && p.title.trim().length > 0) || (Number.isFinite(p.number) && p.number > 0),
  { message: 'season requires a non-empty title or a number > 0' },
);
const seasonPatchSchema = seasonSchema.refine(
  (p) => Object.keys(p).length > 0,
  { message: 'patch must include at least one field' },
);
const seasonDeleteSchema = z.object({
  reassignTo: z.string().trim().min(1).max(64).nullable().optional(),
});

// ---- Issue schemas ----

const issueCreateSchema = z.object({
  title: z.string().trim().min(1).max(issuesSvc.TITLE_MAX),
  number: z.number().int().min(1).max(9999).optional(),
  // Per-issue length profile — can be set at create time so a user creating
  // a standalone oversized issue (e.g. an annual) doesn't have to open the
  // picker after the fact. Defaults server-side to 'standard'.
  lengthProfile: z.enum(LENGTH_PROFILE_NAMES).optional(),
  pageTarget: z.number().int().min(CUSTOM_PAGE_MIN).max(CUSTOM_PAGE_MAX).nullable().optional(),
  minutesTarget: z.number().int().min(CUSTOM_MINUTE_MIN).max(CUSTOM_MINUTE_MAX).nullable().optional(),
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
  aspectRatio: z.enum(ASPECT_RATIOS).nullable().optional(),
  quality: z.enum(QUALITIES).nullable().optional(),
  // Per-stage gen config — image mode + optional pinned model + optional
  // refine-LLM override. Sanitizer drops the field entirely when nothing
  // is set, so a `null` here clears it.
  genConfig: z.object({
    imageMode: z.enum(['auto', 'local', 'codex']).optional(),
    imageModelId: z.string().trim().max(200).nullable().optional(),
    refineProvider: z.string().trim().max(200).nullable().optional(),
    refineModel: z.string().trim().max(200).nullable().optional(),
  }).nullable().optional(),
  // Comic-issue front cover. Only meaningful on the comicPages stage; the
  // service-side sanitizer drops the field on other visual stages.
  cover: z.object({
    script: z.string().max(8000).optional(),
    imageJobId: z.string().trim().max(200).nullable().optional(),
    prompt: z.string().max(16_000).nullable().optional(),
  }).nullable().optional(),
});

const issuePatchSchema = z.object({
  title: z.string().trim().min(1).max(issuesSvc.TITLE_MAX).optional(),
  number: z.number().int().min(1).max(9999).optional(),
  status: z.enum(issuesSvc.ISSUE_STATUSES).optional(),
  // Phase 2 of Story Arc Planning: optional pointer back to a season +
  // ordinal within that season. `null` clears the assignment.
  seasonId: z.string().trim().min(1).max(issuesSvc.SEASON_ID_MAX).nullable().optional(),
  arcPosition: z.number().int().min(0).max(issuesSvc.ARC_POSITION_MAX).nullable().optional(),
  // Per-issue length profile. Drives the prompt-template size targets
  // (beats / prose words / page count / minute count). pageTarget +
  // minutesTarget are only meaningful when lengthProfile === 'custom'.
  lengthProfile: z.enum(LENGTH_PROFILE_NAMES).optional(),
  pageTarget: z.number().int().min(CUSTOM_PAGE_MIN).max(CUSTOM_PAGE_MAX).nullable().optional(),
  minutesTarget: z.number().int().min(CUSTOM_MINUTE_MIN).max(CUSTOM_MINUTE_MAX).nullable().optional(),
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
  seed: z.number().int().min(0).optional(),
});

// Comic-issue front cover render. Accepts an optional `coverScript`
// override (otherwise the route reads it from stages.comicPages.cover.script);
// the rest of the prompt is built server-side from series + issue metadata.
// `seed` mirrors the page/panel render schemas so the shared image-gen drawer
// flows the same render settings into the cover — enqueueImageJob honors it
// via options.seed.
const comicCoverRenderSchema = z.object({
  coverScript: z.string().max(8000).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum(['local', 'codex']).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
});

// Full-comic-page render: same knobs as panel render minus `description` /
// `slugline` (the prompt is built server-side from the page's panels[] so it
// stays in sync with whatever the script-extractor produced).
const comicPageRenderSchema = z.object({
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum(['local', 'codex']).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
});

const episodeVideoSchema = z.object({
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  quality: z.enum(QUALITIES).optional(),
  modelId: z.string().trim().max(64).optional(),
  force: z.boolean().optional(),
});

// Single-scene video render. Lighter schema than episodeVideo because there
// is no stitch step — just one t2v render against the scene's existing
// description.
const sceneVideoSchema = z.object({
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  modelId: z.string().trim().max(64).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
});

// Provider/model picker for the LLM-driven panel/scene prompt refine. Both
// are optional — server falls back to the active provider + stage default.
const promptRefineSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
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

const extractComicPagesSchema = z.object({
  force: z.boolean().optional(),
});

const comicPagePatchSchema = z.object({
  rawText: z.string().max(40000),
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

// Arc / season-episodes / verify — Phase 3 of Story Arc Planning. The three
// LLM calls share a provider/model override shape; the first two also accept
// `commit: true` to persist the LLM output (skipping the preview/confirm step).
const providerOverrideShape = {
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(200).optional(),
};
const arcGenerateSchema = z.object({ ...providerOverrideShape, commit: z.boolean().optional() });
const seasonEpisodesGenerateSchema = z.object({ ...providerOverrideShape, commit: z.boolean().optional() });
const arcVerifySchema = z.object(providerOverrideShape);

// Auto-resolve verification findings. `findings` empty/omitted = re-verify
// first then resolve everything; otherwise the LLM only addresses the
// caller-supplied subset (per-finding "Resolve" buttons).
const verifyFindingSchema = z.object({
  severity: z.enum(['high', 'medium', 'low']).optional(),
  location: z.string().trim().max(200).optional(),
  problem: z.string().trim().min(1).max(2000),
  suggestion: z.string().trim().max(2000).optional(),
});
const arcResolveSchema = z.object({
  ...providerOverrideShape,
  findings: z.array(verifyFindingSchema).max(50).optional(),
});

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
  // mergeExtractedBible stays a service-internal concern. (Phase B note:
  // this still writes into series.characters; the per-issue Nouns page
  // reads from there. Render paths prefer universe canon via
  // getSeriesCanon — so once the user runs migrateSeriesCanon and starts
  // managing canon on the Universe Canon page, this legacy series-write
  // becomes dead-end data. Removed in Phase B.2 when the Nouns page
  // points at universe directly.)
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

const refineCharacterSchema = z.object({
  providerId: z.string().trim().max(64).optional(),
  model: z.string().trim().max(128).optional(),
});

// LLM-driven rewrite of one character's physicalDescription so the rendered
// image differs from every peer. Preserves evidence + firstAppearance. Returns
// the updated series so the client can reactively swap state without a refetch.
router.post('/series/:id/characters/:entryId/refine', asyncHandler(async (req, res) => {
  const body = validateRequest(refineCharacterSchema, req.body ?? {});
  const result = await refineCharacterDescription(req.params.id, req.params.entryId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
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
// Season routes — Phase 2 of Story Arc Planning. Seasons live inside
// `series.seasons[]` but get their own resource so a single-season edit
// doesn't have to re-PATCH the entire series record.
// =====================

router.get('/series/:id/seasons', asyncHandler(async (req, res) => {
  const seasons = await seasonsSvc.listSeasons(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  res.json(seasons);
}));

router.post('/series/:id/seasons', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(seasonCreateSchema, req.body ?? {});
  const created = await seasonsSvc.createSeason(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.status(201).json(created);
}));

router.patch('/series/:id/seasons/:seasonId', asyncHandler(async (req, res) => {
  const body = validateRequest(seasonPatchSchema, req.body ?? {});
  const updated = await seasonsSvc.updateSeason(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(updated);
}));

router.delete('/series/:id/seasons/:seasonId', asyncHandler(async (req, res) => {
  // Reassign target arrives via the request body so HTTP DELETE stays valid;
  // a query-param fallback would invite the same content twice in different
  // shapes. Body is optional — omitting it un-groups every child issue.
  const body = validateRequest(seasonDeleteSchema, req.body ?? {});
  const result = await seasonsSvc.deleteSeason(req.params.id, req.params.seasonId, {
    reassignTo: body.reassignTo ?? null,
  }).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// =====================
// Arc planning routes — Phase 3 of Story Arc Planning. Three LLM-driven
// passes that propose (and optionally commit) arc-level metadata + season
// outlines + per-episode breakdowns.
// =====================

// Top-of-arc generation: proposes `series.arc` + `series.seasons[]` from the
// series bible. With `commit: true` persists the result in one shot; default
// returns a preview the UI can confirm before writing.
router.post('/series/:id/arc/generate', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcGenerateSchema, req.body ?? {});
  const result = await arcPlanner.generateArcOverview(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  let series = null;
  if (body.commit) {
    series = await seriesSvc.updateSeries(req.params.id, {
      arc: result.arc,
      seasons: result.seasons,
    }).catch((err) => { throw mapServiceError(err); });
  }
  res.json({
    arc: result.arc,
    seasons: result.seasons,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
    committed: !!body.commit,
    series,
  });
}));

// Per-season episode generation. Proposes (and optionally commits) the
// per-episode breakdown for one season. With `commit: true`, creates one
// issue per episode with the season pointer + arcPosition pre-filled.
router.post('/series/:id/seasons/:seasonId/episodes/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(seasonEpisodesGenerateSchema, req.body ?? {});
  const result = await arcPlanner.generateSeasonEpisodes(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });

  const createdIssues = [];
  let bibleExtracted = null;
  if (body.commit) {
    // Create one issue per episode under this season. The issue sanitizer
    // already accepts `seasonId` + `arcPosition`, so we forward them in the
    // create payload. The episode's `synopsis` lands in `stages.idea.input`
    // so the downstream auto-run-text chain has a seed to expand against.
    for (const ep of result.episodes) {
      const created = await issuesSvc.createIssue({
        seriesId: req.params.id,
        title: ep.title,
        // Issue `number` is series-scoped (the existing canonical counter);
        // `arcPosition` is the season-scoped ordinal the LLM gave us. We let
        // `createIssue` pick the series number so existing issues' numbers
        // don't collide.
        seasonId: req.params.seasonId,
        arcPosition: ep.number,
        // Episode-level length sizing from the season-episodes LLM pass.
        // Defaults to 'standard' inside the issue sanitizer when missing.
        lengthProfile: ep.lengthProfile,
        stages: {
          idea: {
            status: ep.synopsis ? 'edited' : 'empty',
            input: [ep.logline, ep.synopsis].filter(Boolean).join('\n\n'),
          },
        },
      });
      createdIssues.push(created);
    }

    // Non-fatal: episode creation already succeeded, so a noisy extraction
    // failure must not invalidate the user's accepted breakdown.
    const corpus = result.episodes
      .map((ep) => `## E${ep.number} — ${ep.title}\n\n${ep.logline || ''}\n\n${ep.synopsis || ''}`.trim())
      .filter(Boolean)
      .join('\n\n');
    if (corpus.trim()) {
      const extractRes = await seriesSvc.extractAndMergeIntoSeries(req.params.id, {
        corpus,
        providerOverride: body.providerOverride,
        parallel: true,
      }).catch((err) => {
        console.warn(`⚠️ Continuity extraction failed for season ${req.params.seasonId}: ${err.message}`);
        return null;
      });
      if (extractRes) {
        bibleExtracted = {
          characters: extractRes.results.characters?.extracted?.length || 0,
          settings: extractRes.results.settings?.extracted?.length || 0,
          objects: extractRes.results.objects?.extracted?.length || 0,
          series: extractRes.series,
        };
      }
    }
  }

  res.json({
    season: result.season,
    episodes: result.episodes,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
    committed: !!body.commit,
    createdIssues,
    bibleExtracted,
  });
}));

router.post('/series/:id/arc/verify', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcVerifySchema, req.body ?? {});
  const result = await arcPlanner.verifyArc(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Auto-resolve verification findings. Persists the LLM's patched arc + season
// outlines in one call. Per-episode issue records are not touched.
router.post('/series/:id/arc/resolve-issues', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcResolveSchema, req.body ?? {});
  const result = await arcPlanner.resolveVerifyIssues(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// =====================
// Issue routes
// =====================

// Recent issues across all series — used by the sidebar's dynamic Pipeline
// child list. Routes through `listRecentIssues` which sorts the FULL issue
// set by `updatedAt` desc before applying limit; `listIssues` would
// silently miss the most-recent items once the dataset grows past
// `ISSUES_PER_RESPONSE_MAX` (1000).
router.get('/issues/recent', asyncHandler(async (req, res) => {
  // Forward the raw query value to the service — it owns clamping +
  // non-finite handling, and applying our own `Number(...) || 10` here
  // would silently disagree with the service (e.g. limit=0 ends up as 10
  // via the route but clamps to 1 in the service). Pass through and let
  // listRecentIssues coerce.
  const [issues, series] = await Promise.all([
    issuesSvc.listRecentIssues({ limit: req.query.limit }),
    seriesSvc.listSeries(),
  ]);
  const seriesById = new Map(series.map((s) => [s.id, s.name]));
  res.json(issues.map((i) => ({
    id: i.id,
    title: i.title,
    number: i.number,
    seriesId: i.seriesId,
    seriesName: seriesById.get(i.seriesId) || '(unknown series)',
    updatedAt: i.updatedAt,
  })));
}));

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

router.post('/issues/:id/stages/comicPages/extract-pages', asyncHandler(async (req, res) => {
  const body = validateRequest(extractComicPagesSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });

  const source = (issue.stages?.comicScript?.output || '').trim();
  if (!source) {
    throw new ServerError(
      `Cannot extract pages — issue's comicScript stage is empty`,
      { status: 400, code: 'PIPELINE_NO_SOURCE_FOR_PAGE_EXTRACT' },
    );
  }

  const existing = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  if (existing.length > 0 && !body.force) {
    throw new ServerError(
      `Comic pages already has ${existing.length} page${existing.length === 1 ? '' : 's'} — pass { force: true } to replace`,
      { status: 409, code: 'PIPELINE_COMIC_PAGES_NOT_EMPTY' },
    );
  }

  const { pages, coverConcept } = parseComicScript(source);

  // Preserve a user-edited cover script if one is already set — only seed
  // from the parsed concept when the cover is currently blank. Otherwise an
  // extract re-run would clobber a hand-curated cover. When we DO seed, also
  // clear any prior imageJobId / prompt — they were rendered against the old
  // (likely placeholder / fallback) script, so leaving them would show a
  // rendered cover image that doesn't match the new concept text.
  const existingCover = issue.stages?.comicPages?.cover || null;
  const existingCoverScript = existingCover?.script || '';
  const nextCover = coverConcept && !existingCoverScript
    ? { script: coverConcept, imageJobId: null, prompt: null }
    : existingCover;

  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(issue.id, 'comicPages', {
    status: pages.length ? 'ready' : 'empty',
    pages,
    cover: nextCover,
    errorMessage: '',
  });

  const panelCount = pages.reduce((n, p) => n + (p.panels?.length || 0), 0);
  res.json({
    issue: updatedIssue,
    stage,
    pageCount: pages.length,
    panelCount,
  });
}));

// Per-page rawText patch — re-parses panels from the edited markdown so a
// subsequent render still gets a structured prompt. Page's `imageJobId` is
// preserved so the user doesn't lose an in-flight render after a save.
router.patch('/issues/:id/stages/comicPages/pages/:pageIndex', asyncHandler(async (req, res) => {
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const body = validateRequest(comicPagePatchSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? [...issue.stages.comicPages.pages] : [];
  if (!pages[pageIndex]) {
    throw new ServerError(
      `pageIndex ${pageIndex} out of range — comicPages has ${pages.length} page${pages.length === 1 ? '' : 's'}`,
      { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
    );
  }
  const { pages: reparsed } = parseComicScript(body.rawText);
  const fresh = reparsed[0] || { panels: [], rawText: body.rawText };
  pages[pageIndex] = {
    ...pages[pageIndex],
    rawText: fresh.rawText || body.rawText,
    panels: fresh.panels.map((p, i) => ({
      ...p,
      // Preserve in-flight per-panel jobIds when the panel survived the re-parse.
      imageJobId: pages[pageIndex].panels?.[i]?.imageJobId ?? p.imageJobId ?? null,
    })),
  };
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'comicPages', {
    status: 'edited',
    pages,
  });
  res.json({ issue: updatedIssue, stage, page: pages[pageIndex] });
}));

// Render the comic-issue front cover. Builds a cover-art prompt (series
// masthead + issue-number tag + the user's cover concept) and persists the
// returned jobId on stages.comicPages.cover.imageJobId. Pass `coverScript`
// in the body to override or update the persisted cover concept in the
// same call. Returns { jobId, mode, prompt, cover, issue, stage }.
router.post('/issues/:id/stages/comicPages/cover/render', asyncHandler(async (req, res) => {
  const body = validateRequest(comicCoverRenderSchema, req.body ?? {});
  // Make sure the issue exists up front — defense in depth + clean 404
  // before we spend the bible-context load.
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });

  const result = await enqueueComicCover(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });

  // Persist coverScript + jobId + prompt back onto the issue so the UI
  // shows the in-flight render on reload, even if the user navigates away.
  const nextCover = {
    script: result.coverScript || '',
    imageJobId: result.jobId,
    prompt: result.prompt,
  };
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'comicPages', {
    cover: nextCover,
  });
  res.json({ ...result, cover: stage.cover, issue: updatedIssue, stage });
}));

// Render a full comic page (multi-panel layout in one image) — the
// recommended default for cloud-class image models (Codex, Google Imagen);
// local diffusion models can render this but tend to produce draft-quality
// pages, so the per-panel `/visual` endpoint remains the fallback.
//
// Persists the returned jobId on stages.comicPages.pages[pageIndex].imageJobId
// so the UI can show the page-level render alongside the per-panel renders.
router.post('/issues/:id/stages/comicPages/pages/:pageIndex/render', asyncHandler(async (req, res) => {
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const body = validateRequest(comicPageRenderSchema, req.body ?? {});

  // Validate the page exists up front so we skip the enqueue work entirely
  // when the index is bad. The service also throws ServerError(404) for the
  // same case (defense in depth — any other caller still gets a clean 404),
  // but checking here avoids loading the bible context just to error out.
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? [...issue.stages.comicPages.pages] : [];
  if (!pages[pageIndex]) {
    throw new ServerError(
      `pageIndex ${pageIndex} out of range — comicPages has ${pages.length} page${pages.length === 1 ? '' : 's'}`,
      { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
    );
  }

  const result = await enqueueVisualComicPage(req.params.id, { pageIndex, ...body })
    .catch((err) => { throw mapServiceError(err); });

  // Persist the jobId on the page so a reload still shows the in-flight render.
  pages[pageIndex] = { ...pages[pageIndex], imageJobId: result.jobId, prompt: result.prompt };
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'comicPages', {
    status: 'edited',
    pages,
  });
  res.json({ ...result, issue: updatedIssue, stage });
}));

// AI-driven prompt refinement for a single comic panel. Uses
// pipeline-comic-panel-image-prompt stage to elaborate the panel's existing
// description into a richer image-gen prompt, then persists the result on
// the panel.
router.post('/issues/:id/stages/comicPages/pages/:pageIndex/panels/:panelIndex/refine-prompt',
  asyncHandler(async (req, res) => {
    const body = validateRequest(promptRefineSchema, req.body ?? {});
    const result = await refineComicPanelPrompt(
      req.params.id,
      Number(req.params.pageIndex),
      Number(req.params.panelIndex),
      body,
    ).catch((err) => { throw mapServiceError(err); });
    res.json(result);
  }),
);

// AI-driven prompt refinement for a single storyboard scene. Mirror of the
// comic-panel refine but uses pipeline-storyboard-image-prompt.
router.post('/issues/:id/stages/storyboards/scenes/:index/refine-prompt',
  asyncHandler(async (req, res) => {
    const body = validateRequest(promptRefineSchema, req.body ?? {});
    const result = await refineStoryboardScenePrompt(
      req.params.id,
      Number(req.params.index),
      body,
    ).catch((err) => { throw mapServiceError(err); });
    res.json(result);
  }),
);

// Render a single storyboard scene as a video clip, independent of the
// full episode-video stitch. Persists the resulting jobId on the scene's
// `sceneVideoJobId` so a reload still shows the in-flight render.
router.post('/issues/:id/stages/storyboards/scenes/:index/video', asyncHandler(async (req, res) => {
  const idx = Number(req.params.index);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new ServerError('scene index must be a non-negative integer', {
      status: 400, code: 'PIPELINE_SCENE_BAD_INDEX',
    });
  }
  const body = validateRequest(sceneVideoSchema, req.body ?? {});
  const result = await enqueueStoryboardSceneVideo(req.params.id, idx, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
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
