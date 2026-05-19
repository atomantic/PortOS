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
  imageEdgeSchema,
  refineImagePixelCap,
  PIXEL_CAP_MESSAGE,
} from '../lib/validation.js';
import * as seriesSvc from '../services/pipeline/series.js';
import * as issuesSvc from '../services/pipeline/issues.js';
import * as seasonsSvc from '../services/pipeline/seasons.js';
import * as arcPlanner from '../services/pipeline/arcPlanner.js';
import { generateStage } from '../services/pipeline/textStages.js';
import * as autoRunner from '../services/pipeline/autoRunner.js';
import * as volumeBeatsRunner from '../services/pipeline/volumeBeatsRunner.js';
import {
  enqueueVisualImage,
  enqueueVisualComicPage,
  enqueueComicCover,
  enqueueComicBackCover,
  enqueueVolumeCover,
  enqueueVolumeBackCover,
  enqueueStoryboardSceneVideo,
  enqueueStoryboardShotStartFrame,
  refineComicPanelPrompt,
  refineStoryboardScenePrompt,
  buildRenderSlot,
} from '../services/pipeline/visualStages.js';
import { extractCanonFromProse } from '../services/universeCanon.js';
import { IMPORTER_SOURCE_CHAR_LIMIT } from '../services/importer.js';
import { getSeriesCanon } from '../services/pipeline/seriesCanon.js';
import { startEpisodeVideoForIssue, ERR_NO_STORYBOARDS } from '../services/pipeline/episodeVideo.js';
import { generateSeriesTitleLogo } from '../services/pipeline/seriesTitleLogo.js';
import { COMIC_PAGE_VARIANTS, slotKeyForVariant } from '../services/pipeline/owners.js';
import { ASPECT_RATIOS, QUALITIES } from '../lib/creativeDirectorPresets.js';
import { extractScenes, SOURCE_KIND } from '../lib/sceneExtractor.js';
import { listVisualStyles } from '../lib/visualStyles.js';
import { buildComicPdf, PAGE_SIZES, DEFAULT_PAGE_SIZE, ERR_NO_RENDERED_PAGES } from '../services/pipeline/comicPdf.js';
import {
  buildVolumePdf,
  ERR_NO_VOLUME_COVER, ERR_NO_RENDERED_ISSUES,
} from '../services/pipeline/volumePdf.js';
import { listAllVoices, synthesizeToFile, parseVoiceId, extractDialogueLines, resolveVoiceForLine } from '../services/pipeline/audio.js';
import { synthesize as synthesizeVoice } from '../services/voice/tts.js';
import {
  listMusicLibrary,
  importUploadedTrack,
  deleteMusicTrack,
  statMusicTrack,
  isSupportedMusicUpload,
  MUSIC_SOURCE,
  MUSIC_UPLOAD_MAX_BYTES,
} from '../services/pipeline/musicLibrary.js';
import { uploadSingle } from '../lib/multipart.js';
import { parseComicScript } from '../lib/comicScriptParser.js';
import {
  LENGTH_PROFILE_NAMES,
  CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX,
} from '../lib/issueLength.js';
import { llmSchema } from './universeBuilder.js';
import { ARC_LIMITS, ARC_STATUSES, ARC_SHAPE_IDS, ARC_ROLES, SEASON_STATUSES } from '../lib/storyArc.js';

const router = Router();

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
  [ERR_NO_STORYBOARDS]: 400,
  [ERR_NO_RENDERED_PAGES]: 409,
  [ERR_NO_VOLUME_COVER]: 409,
  [ERR_NO_RENDERED_ISSUES]: 409,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

// ---- Series schemas ----
//
// Canon (characters / places / objects) is no longer carried on a series
// payload — it lives on the linked universe (Phase B.4). The bible-entry
// Zod shapes (`characterSchema` et al.) and the `BIBLE_KIND` plumbing moved
// out of this file when the series-side canon routes were retired.

// Visual style ref — `{ id, customPrompt? }`. The id is validated lazily
// (against the catalog in server/lib/visualStyles.js) by the sanitizer at
// persist time so adding a new style doesn't force a schema bump. `id: null`
// + `customPrompt: "..."` is the valid "custom only" shape — preventing it
// here would force the UI to invent a sentinel id just to clear the picker.
const visualStyleRefSchema = z.object({
  id: z.string().trim().max(64).nullable().optional(),
  customPrompt: z.string().trim().max(2000).nullable().optional(),
}).nullable();

// Arc + Season — phase 2 of Story Arc Planning. The arc lives on the series
// record itself; seasons get their own resource so the route layer can take
// per-record CRUD without forcing the caller to PATCH the whole series.
const arcSchema = z.object({
  logline: z.string().trim().max(ARC_LIMITS.LOGLINE_MAX).optional().default(''),
  summary: z.string().trim().max(ARC_LIMITS.SUMMARY_MAX).optional().default(''),
  protagonistArc: z.string().trim().max(ARC_LIMITS.PROTAGONIST_ARC_MAX).optional().default(''),
  themes: z.array(z.string().trim().min(1).max(ARC_LIMITS.THEME_MAX))
    .max(ARC_LIMITS.THEMES_PER_ARC_MAX).optional(),
  shape: z.enum(ARC_SHAPE_IDS).nullable().optional(),
  status: z.enum(ARC_STATUSES).optional(),
});

// Volume-cover / back-cover sub-schema — accepts the script text plus the
// pre-split legacy fields. Render-slot details (`proofImage`, `finalImage`)
// arrive only from the render route's PATCH path, which builds them
// server-side; PATCHes of the season metadata only carry the user-editable
// `script`. Explicit shape (not `.passthrough()`) so the "all inputs
// validated" CLAUDE.md convention holds for new fields.
const seasonCoverSchema = z.object({
  script: z.string().max(8000).optional(),
  imageJobId: z.string().trim().max(200).nullable().optional(),
  prompt: z.string().max(16_000).nullable().optional(),
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
  cover: seasonCoverSchema.nullable().optional(),
  backCover: seasonCoverSchema.nullable().optional(),
  status: z.enum(SEASON_STATUSES).optional(),
  // Per-season editorial lock. Enforced by `seasonsSvc.updateSeason` (refuses
  // content patches while locked) and `arcPlanner.generateSeasonEpisodes` /
  // `issuesSvc.bulkReassignSeason` / `seasonsSvc.deleteSeason` (refuse on
  // locked seasons). The sibling arc-level lock lives on `series.locked.arc`.
  locked: z.boolean().optional(),
}).passthrough();

// `.passthrough` keeps the door open for future per-season / per-field locks
// without a schema bump — the series sanitizer is the source of truth.
const seriesLockedSchema = z.object(
  Object.fromEntries(seriesSvc.LOCKABLE_STAGES.map((k) => [k, z.boolean().optional()])),
).passthrough();

const seriesCreateSchema = z.object({
  name: z.string().trim().min(1).max(seriesSvc.NAME_MAX),
  logline: z.string().trim().max(seriesSvc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(seriesSvc.PREMISE_MAX).optional().default(''),
  universeId: z.string().trim().max(seriesSvc.UNIVERSE_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(seriesSvc.WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  locked: seriesLockedSchema.optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional().default(''),
  titleLogo: z.string().trim().max(seriesSvc.TITLE_LOGO_MAX).optional().default(''),
  author: z.string().trim().max(seriesSvc.AUTHOR_MAX).optional().default(''),
  stylePromptOverride: z.string().trim().max(seriesSvc.STYLE_PROMPT_OVERRIDE_MAX).optional().default(''),
  visualStyleDefault: visualStyleRefSchema.optional(),
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
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  locked: seriesLockedSchema.optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional(),
  titleLogo: z.string().trim().max(seriesSvc.TITLE_LOGO_MAX).optional(),
  author: z.string().trim().max(seriesSvc.AUTHOR_MAX).optional(),
  stylePromptOverride: z.string().trim().max(seriesSvc.STYLE_PROMPT_OVERRIDE_MAX).optional(),
  visualStyleDefault: visualStyleRefSchema.optional(),
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
  // Comic-issue back cover — identical shape to `cover`. Only meaningful
  // on the comicPages stage. The render route + filename hook treat the
  // two slots symmetrically; only the rendered prompt differs (no
  // masthead, explicit no-text negative — back covers are illustration-
  // only).
  backCover: z.object({
    script: z.string().max(8000).optional(),
    imageJobId: z.string().trim().max(200).nullable().optional(),
    prompt: z.string().max(16_000).nullable().optional(),
  }).nullable().optional(),
  // Per-stage visual style override. Validated lazily by the sanitizer
  // (unknown catalog ids are dropped) so adding a new style doesn't force
  // a schema bump on every client.
  visualStyleOverride: visualStyleRefSchema.optional(),
});

// Audio stage payloads carry lines[] (voice-over per dialogue line) + a
// nullable music descriptor. Light validation — the sanitizer in
// services/pipeline/issues.js enforces per-line + per-music shape. Without
// this arm in the union below, audio PATCHes silently fall through to the
// base stageInputSchema and Zod strips lines[]/music.
const audioStageInputSchema = stageInputSchema.extend({
  lines: z.array(z.any()).max(1000).optional(),
  music: z.any().nullable().optional(),
});

const issuePatchSchema = z.object({
  title: z.string().trim().min(1).max(issuesSvc.TITLE_MAX).optional(),
  number: z.number().int().min(1).max(9999).optional(),
  status: z.enum(issuesSvc.ISSUE_STATUSES).optional(),
  // Phase 2 of Story Arc Planning: optional pointer back to a season +
  // ordinal within that season. `null` clears the assignment.
  seasonId: z.string().trim().min(1).max(issuesSvc.SEASON_ID_MAX).nullable().optional(),
  arcPosition: z.number().int().min(0).max(issuesSvc.ARC_POSITION_MAX).nullable().optional(),
  arcRole: z.enum(ARC_ROLES).nullable().optional(),
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
  // Union order matters: Zod picks the first arm that succeeds, so the
  // more-specific schemas (visual, audio) must precede the bare base.
  stages: z.record(z.string(), z.union([visualStageInputSchema, audioStageInputSchema, stageInputSchema])).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const generateSchema = z.object({
  seedInput: z.string().max(issuesSvc.STAGE_INPUT_MAX).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

const visualGenerateSchema = z.object({
  description: z.string().trim().min(1).max(8000),
  // Matched against the series places bible when present.
  slugline: z.string().trim().max(200).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum(['local', 'codex']).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

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
  mode: z.enum(['local', 'codex']).optional(),
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

// Full-comic-page render: same knobs as panel render minus `description` /
// `slugline` (the prompt is built server-side from the page's panels[] so it
// stays in sync with whatever the script-extractor produced).
const comicPageRenderSchema = z.object({
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum(['local', 'codex']).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  // See comicCoverRenderSchema for the proof/final semantics.
  target: z.enum(COMIC_PAGE_VARIANTS).optional().default('proof'),
  useProofAsBase: z.boolean().optional().default(false),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

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
// granular paragraph-grain breakdown via `writers-room-script`; `teleplay`
// → slugline-grain parse via `pipeline-extract-scenes`). `force` overrides
// the "you have N hand-curated scenes already" guard.
// Enum values match `SOURCE_KIND` verbatim so the route forwards `body.from`
// straight through — same string also names the issue's text stage.
const extractScenesSchema = z.object({
  from: z.enum([SOURCE_KIND.PROSE, SOURCE_KIND.TELEPLAY]).optional().default(SOURCE_KIND.TELEPLAY),
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(128).optional(),
  force: z.boolean().optional(),
});

const extractComicPagesSchema = z.object({
  force: z.boolean().optional(),
});

const extractCanonFromScriptSchema = z.object({
  providerOverride: z.string().trim().max(80).optional(),
});

// Reuses the importer's source-size ceiling — both feed the same
// `extractBible` machinery, so a single constant keeps the safe-corpus
// budget in sync. `STAGE_OUTPUT_MAX` (400KB) is large enough that long
// scripts can exceed most provider context windows; clamp before forwarding.
const EXTRACT_CANON_CORPUS_MAX = IMPORTER_SOURCE_CHAR_LIMIT;

// Collapses the `extractCanonFromProse` result-shape trio used by both the
// season-episodes continuity extract and the manual script-stage extract.
const countExtractedCanon = (results) => ({
  characters: results.characters?.extracted?.length || 0,
  places: results.places?.extracted?.length || 0,
  objects: results.objects?.extracted?.length || 0,
});

const comicPagePatchSchema = z.object({
  rawText: z.string().max(40000),
});

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
// Volume / season verify shares the same provider/model override shape.
const volumeVerifySchema = z.object(providerOverrideShape);

// Volume beat-sheets bulk generator. `mode` defaults to skip-existing so a
// rerun on a partially-expanded volume only fills empty slots; the explicit
// 'regenerate-all' is the "blow away every beat sheet" path.
const volumeBeatsGenerateSchema = z.object({
  ...providerOverrideShape,
  mode: z.enum(volumeBeatsRunner.VOLUME_BEATS_MODES).optional().default('skip-existing'),
});

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

// Static catalog. Express's default ETag handles re-fetches; clients also
// dedup via the module-level promise cache in apiPipeline.js.
router.get('/visual-styles', asyncHandler(async (_req, res) => {
  res.json({ styles: listVisualStyles() });
}));

// Merged voice list across every supported TTS engine (Kokoro + Piper today;
// future ElevenLabs/etc. when added). Each voice is namespaced with
// `engine:voiceName` so the character voice picker shows a single flat list.
router.get('/tts/voices', asyncHandler(async (_req, res) => {
  res.json({ voices: await listAllVoices() });
}));

// Audition a voice before binding it to a character. Returns the rendered
// WAV inline so the picker can <audio> it without persisting anything. Body:
// { voiceId, text? } — text defaults to a short generic sample.
const ttsPreviewSchema = z.object({
  voiceId: z.string().trim().min(1).max(200),
  text: z.string().trim().max(500).optional(),
});
const DEFAULT_PREVIEW_TEXT = 'The morning fog burned off slow that day, and nothing felt quite the same after.';
router.post('/tts/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(ttsPreviewSchema, req.body ?? {});
  const { engine, voice } = parseVoiceId(body.voiceId);
  const text = body.text || DEFAULT_PREVIEW_TEXT;
  // Surface "unknown voice" + transient model-load failures as 400/503 with
  // a useful message instead of asyncHandler's default 500.
  let wav; let latencyMs; let usedEngine;
  try {
    ({ wav, latencyMs, engine: usedEngine } = await synthesizeVoice(text, {
      ...(engine ? { engine } : {}),
      ...(voice ? { voice } : {}),
    }));
  } catch (err) {
    if (err?.message?.startsWith('unknown') || err?.code === 'UNKNOWN_VOICE') {
      throw new ServerError(err.message, { status: 400, code: 'PIPELINE_AUDIO_UNKNOWN_VOICE' });
    }
    throw err;
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
  res.setHeader('X-TTS-Engine', usedEngine);
  res.send(wav);
}));

// Persist a one-off voice line to disk under PATHS.audio and return the
// resulting filename. The audio stage's lines[] table calls this to render
// individual dialogue lines; the bulk "render all dialogue" flow lands in
// a follow-up. Mainly intended for the per-line Render button in the UI.
const ttsSynthesizeSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  voiceId: z.string().trim().max(200).optional(),
});
router.post('/tts/synthesize', asyncHandler(async (req, res) => {
  const body = validateRequest(ttsSynthesizeSchema, req.body ?? {});
  const result = await synthesizeToFile({ text: body.text, voiceId: body.voiceId })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Walk the issue's storyboards.scenes[].dialogue and populate
// stages.audio.lines[]. `force: true` replaces existing lines wholesale;
// the default refuses overwrite when lines[] is already populated so a
// stray click can't wipe a user's manual edits.
const extractAudioLinesSchema = z.object({ force: z.boolean().optional() });
router.post('/issues/:id/stages/audio/extract-lines', asyncHandler(async (req, res) => {
  const body = validateRequest(extractAudioLinesSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const existingLines = issue.stages?.audio?.lines || [];
  if (existingLines.length > 0 && !body.force) {
    throw new ServerError(
      `Audio stage already has ${existingLines.length} line${existingLines.length === 1 ? '' : 's'}. Pass force: true to replace.`,
      { status: 409, code: 'PIPELINE_AUDIO_LINES_EXIST' },
    );
  }
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });
  // Carry forward already-rendered audio on re-extract when the same speaker
  // + same line text appears in the fresh extraction — otherwise a small edit
  // anywhere upstream would silently invalidate every previously-rendered WAV.
  // Phase B.4: canon lives on the linked universe — bind dialogue speakers
  // by name against `universe.characters` instead of the now-defunct
  // `series.characters`.
  const canon = await getSeriesCanon(series);
  const { lines, preservedCount } = extractDialogueLines(issue, { characters: canon.characters }, {
    preserveFrom: existingLines,
  });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'audio', {
    status: lines.length ? 'ready' : 'empty',
    lines,
    errorMessage: '',
  });
  res.json({ issue: updatedIssue, stage, lineCount: lines.length, preservedCount });
}));

// Per-line edit endpoint. Replaces the prior whole-stage PATCH path so a
// blur-save against line N can't clobber a concurrent edit against line M
// — the server merges against the freshest persisted record inside the
// per-issue write queue. Patch fields are intentionally narrow (text +
// voiceIdOverride); the per-line audio fields are owned by the render path.
const lineEditSchema = z.object({
  text: z.string().max(4000).optional(),
  voiceIdOverride: z.string().trim().max(200).nullable().optional(),
});
router.patch('/issues/:id/stages/audio/lines/:lineIdx', asyncHandler(async (req, res) => {
  const lineIdx = Number(req.params.lineIdx);
  if (!Number.isInteger(lineIdx) || lineIdx < 0) {
    throw new ServerError('lineIdx must be a non-negative integer', {
      status: 400, code: 'PIPELINE_AUDIO_BAD_INDEX',
    });
  }
  const body = validateRequest(lineEditSchema, req.body ?? {});
  if (Object.keys(body).length === 0) {
    throw new ServerError('patch must include at least one field', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => {
      const lines = Array.isArray(current?.lines) ? current.lines : [];
      const line = lines[lineIdx];
      if (!line) return {};
      const next = { ...line };
      if ('text' in body) next.text = body.text;
      if ('voiceIdOverride' in body) next.voiceIdOverride = body.voiceIdOverride;
      const nextLines = [...lines];
      nextLines[lineIdx] = next;
      return { status: 'edited', lines: nextLines };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, lineIdx });
}));

// Render one VO line. Voice resolution priority:
//   1. body.voiceId           (per-request override)
//   2. line.voiceIdOverride   (per-line override saved on the issue)
//   3. character.voiceId      (linked-universe canon binding via getSeriesCanon)
//   4. (none → uses the configured default voice via synthesize())
const lineRenderSchema = z.object({ voiceId: z.string().trim().max(200).optional() });
router.post('/issues/:id/stages/audio/lines/:lineIdx/render', asyncHandler(async (req, res) => {
  const lineIdx = Number(req.params.lineIdx);
  if (!Number.isInteger(lineIdx) || lineIdx < 0) {
    throw new ServerError('lineIdx must be a non-negative integer', {
      status: 400, code: 'PIPELINE_AUDIO_BAD_INDEX',
    });
  }
  const body = validateRequest(lineRenderSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const lines = issue.stages?.audio?.lines || [];
  const line = lines[lineIdx];
  if (!line) {
    throw new ServerError(`lineIdx ${lineIdx} out of range (have ${lines.length})`, {
      status: 404, code: 'PIPELINE_AUDIO_LINE_NOT_FOUND',
    });
  }
  // Resolve voice via the shared priority chain (explicit > line override
  // > character binding > project default). One source of truth, reused by
  // the eventual "render all" flow + unit-tested for priority order. Skip
  // the canon load when a higher-priority resolver will win — otherwise
  // every per-line render pays two file reads it doesn't use.
  const needsCanon = !body.voiceId?.trim() && !line.voiceIdOverride && line.characterId;
  let canon = null;
  if (needsCanon) {
    const series = await seriesSvc.getSeries(issue.seriesId).catch(() => null);
    if (series) canon = await getSeriesCanon(series);
  }
  const voiceId = resolveVoiceForLine(line, canon, { explicit: body.voiceId });
  const synthResult = await synthesizeToFile({ text: line.text, voiceId })
    .catch((err) => { throw mapServiceError(err); });
  const nextLines = [...lines];
  nextLines[lineIdx] = {
    ...line,
    audioJobId: null,
    audioFilename: synthResult.filename,
  };
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'audio', {
    status: 'edited',
    lines: nextLines,
    errorMessage: '',
  });
  res.json({
    issue: updatedIssue, stage, lineIdx,
    filename: synthResult.filename,
    engine: synthResult.engine,
    voiceId: synthResult.voiceId || voiceId,
  });
}));

// Music library — shared across every issue; the audio stage stores only a
// pointer (`music.trackFilename`). Local OSS generation (4c.2) and 3rd-party
// engines (4c.3) plug in as sibling sources behind the same library list.

const musicUpload = uploadSingle('track', {
  limits: { fileSize: MUSIC_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isSupportedMusicUpload(file)) {
      cb(null, true);
    } else {
      cb(new ServerError(
        'Unsupported audio format — accepted: MP3, WAV, M4A, OGG, FLAC',
        { status: 400, code: 'PIPELINE_MUSIC_UNSUPPORTED_FORMAT' },
      ));
    }
  },
});

// The audio stage status reflects whether the *VO line list* is ready, since
// music alone doesn't make an episode renderable. So music-only mutations
// leave status at 'empty' when no lines exist and bump to 'edited' otherwise.
const audioStatusAfterMusicChange = (issue) =>
  ((issue.stages?.audio?.lines || []).length ? 'edited' : 'empty');

router.get('/audio/music-library', asyncHandler(async (_req, res) => {
  res.json({ tracks: await listMusicLibrary() });
}));

router.post('/issues/:id/stages/audio/music/upload', musicUpload, asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ServerError('No audio file uploaded', {
      status: 400, code: 'PIPELINE_MUSIC_NO_FILE',
    });
  }
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const { filename, sizeBytes } = await importUploadedTrack(req.file.path, req.file.originalname);
  const label = typeof req.body?.label === 'string' && req.body.label.trim()
    ? req.body.label.trim()
    : null;
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'audio', {
    status: audioStatusAfterMusicChange(issue),
    music: { source: MUSIC_SOURCE.UPLOAD, trackFilename: filename, label },
    errorMessage: '',
  });
  res.json({ issue: updatedIssue, stage, music: stage.music, sizeBytes });
}));

const musicAttachSchema = z.object({
  trackFilename: z.string().trim().min(1).max(500),
  label: z.string().trim().max(200).nullable().optional(),
});
router.post('/issues/:id/stages/audio/music/attach', asyncHandler(async (req, res) => {
  const body = validateRequest(musicAttachSchema, req.body ?? {});
  // Single-file stat instead of full library listing — one syscall vs. N+1.
  const found = await statMusicTrack(body.trackFilename);
  if (!found) {
    throw new ServerError('Music track not found in library', {
      status: 404, code: 'PIPELINE_MUSIC_NOT_FOUND',
    });
  }
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'audio', {
    status: audioStatusAfterMusicChange(issue),
    music: {
      source: MUSIC_SOURCE.LIBRARY,
      trackFilename: body.trackFilename,
      label: body.label?.trim() || found.label,
    },
    errorMessage: '',
  });
  res.json({ issue: updatedIssue, stage, music: stage.music });
}));

router.delete('/issues/:id/stages/audio/music', asyncHandler(async (req, res) => {
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(req.params.id, 'audio', {
    status: audioStatusAfterMusicChange(issue),
    music: null,
    errorMessage: '',
  });
  res.json({ issue: updatedIssue, stage });
}));

// Deleting from the library leaves stale `music.trackFilename` pointers on
// issues so the user sees the broken playback and re-picks. Auto-purging
// would scan every issue on every delete; deferred until needed.
router.delete('/audio/music-library/:filename', asyncHandler(async (req, res) => {
  const { filename } = req.params;
  const existed = await deleteMusicTrack(filename);
  res.json({ filename, deleted: existed });
}));

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

router.delete('/series/:id', asyncHandler(async (req, res) => {
  const r = await seriesSvc.deleteSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

// Generate (or regenerate) the series.titleLogo description via the
// `pipeline-series-title-logo` stage. Returns the updated series so the
// client can swap state without a follow-up GET.
const titleLogoGenerateSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});
router.post('/series/:id/generate-title-logo', asyncHandler(async (req, res) => {
  const body = validateRequest(titleLogoGenerateSchema, req.body ?? {});
  const result = await generateSeriesTitleLogo(req.params.id, body)
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
    const cur = await seriesSvc.getSeries(req.params.id)
      .catch((err) => { throw mapServiceError(err); });
    const committed = await arcPlanner.commitSeasonsWithRemap(cur, {
      arc: result.arc,
      seasons: result.seasons,
    }).catch((err) => { throw mapServiceError(err); });
    series = committed.series;
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
        // Issue `number` is derived from (volume order, arcPosition) by
        // `createIssue`'s renumber pass — a new V1 episode falls into V1's
        // slot and later volumes' numbers shift to make room.
        seasonId: req.params.seasonId,
        arcPosition: ep.number,
        // `arcRole` carries the LLM's pilot / complication / midpoint / etc.
        // classification forward so the idea-expansion prompt can size beats
        // to the role (a finale needs a different cadence than a complication).
        arcRole: ep.arcRole,
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
    // failure must not invalidate the user's accepted breakdown. Phase B.4:
    // canon lives on the linked universe — orphan series (no universeId)
    // skip extraction.
    const series = await seriesSvc.getSeries(req.params.id).catch(() => null);
    const corpus = result.episodes
      .map((ep) => `## E${ep.number} — ${ep.title}\n\n${ep.logline || ''}\n\n${ep.synopsis || ''}`.trim())
      .filter(Boolean)
      .join('\n\n');
    if (corpus.trim() && series?.universeId) {
      // Stamp new inserts as series-extracted (autoLock + sourceSeriesId) so
      // continuity-derived canon survives later AI refines and stays
      // attributable to this series. Matches the pre-B.4 series-side
      // extract semantics.
      const extractRes = await extractCanonFromProse(series.universeId, {
        corpus,
        providerOverride: body.providerOverride,
        parallel: true,
        autoLock: true,
        sourceSeriesId: series.id,
      }).catch((err) => {
        console.warn(`⚠️ Continuity extraction failed for season ${req.params.seasonId}: ${err.message}`);
        return null;
      });
      if (extractRes) {
        bibleExtracted = {
          ...countExtractedCanon(extractRes.results),
          universe: extractRes.universe,
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

// Per-volume verify — the deeper, narrower counterpart to /arc/verify.
// Runs the pipeline-volume-verify prompt over a single season's issues,
// going to beat depth when issues have beats and falling back to synopsis
// depth otherwise so a partially-expanded volume can still be validated.
router.post('/series/:id/seasons/:seasonId/verify', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(volumeVerifySchema, req.body ?? {});
  const result = await arcPlanner.verifyVolume(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Sequential beat-sheet (idea stage) generator for every issue in a volume.
// Runs serially so each issue's prompt sees the prior issue's freshly-written
// beats via buildIdeaContextAugment; SSE streams per-issue progress. Pairs
// naturally with the volume verify pass — generate-then-validate is the
// expected workflow.
router.post('/series/:id/seasons/:seasonId/generate-beats', asyncHandler(async (req, res) => {
  const body = validateRequest(volumeBeatsGenerateSchema, req.body ?? {});
  const result = await volumeBeatsRunner.startVolumeBeatsRun(
    req.params.id,
    req.params.seasonId,
    {
      mode: body.mode,
      providerId: body.providerOverride,
      model: body.modelOverride,
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/seasons/${req.params.seasonId}/generate-beats/progress`,
  });
}));

router.get('/series/:id/seasons/:seasonId/generate-beats/progress', (req, res) => {
  const attached = volumeBeatsRunner.attachClient(req.params.seasonId, res);
  if (!attached) {
    res.status(404).json({ error: 'No active beat-sheet run for this volume' });
  }
});

router.post('/series/:id/seasons/:seasonId/generate-beats/cancel', asyncHandler(async (req, res) => {
  const canceled = volumeBeatsRunner.cancelVolumeBeatsRun(req.params.seasonId);
  res.json({ canceled });
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

// Render the volume front cover. Persists the in-flight render slot onto
// season.cover via seriesSvc.updateSeasonOnSeries (queue-serialized) — the
// season-cover filename hook stamps the completed filename later.
// (Missing series / season surface as PIPELINE_SEASON_NOT_FOUND from
// enqueueVolumeCover's loadSeasonContext, mapped to 404 by mapServiceError.)
router.post('/series/:id/seasons/:seasonId/cover/render', asyncHandler(async (req, res) => {
  const body = validateRequest(volumeCoverRenderSchema, req.body ?? {});
  const result = await enqueueVolumeCover(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });

  const slotKey = slotKeyForVariant(result.variant);
  const slotRecord = buildRenderSlot({
    slotKey, jobId: result.jobId, prompt: result.prompt,
    width: body.width, height: body.height, fromProof: result.fromProof,
  });
  const series = await seriesSvc.updateSeasonOnSeries(
    req.params.id,
    req.params.seasonId,
    (cur) => {
      const currentCover = cur?.cover || {};
      return {
        cover: {
          ...currentCover,
          script: result.coverScript || '',
          [slotKey]: slotRecord,
        },
      };
    },
  ).catch((err) => { throw mapServiceError(err); });
  const season = (series.seasons || []).find((s) => s.id === req.params.seasonId);
  res.json({ ...result, season, series });
}));

router.post('/series/:id/seasons/:seasonId/back-cover/render', asyncHandler(async (req, res) => {
  const body = validateRequest(volumeBackCoverRenderSchema, req.body ?? {});
  const result = await enqueueVolumeBackCover(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });

  const slotKey = slotKeyForVariant(result.variant);
  const slotRecord = buildRenderSlot({
    slotKey, jobId: result.jobId, prompt: result.prompt,
    width: body.width, height: body.height, fromProof: result.fromProof,
  });
  const series = await seriesSvc.updateSeasonOnSeries(
    req.params.id,
    req.params.seasonId,
    (cur) => {
      const currentBack = cur?.backCover || {};
      return {
        backCover: {
          ...currentBack,
          script: result.backCoverScript || '',
          [slotKey]: slotRecord,
        },
      };
    },
  ).catch((err) => { throw mapServiceError(err); });
  const season = (series.seasons || []).find((s) => s.id === req.params.seasonId);
  res.json({ ...result, season, series });
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
// prose (paragraph-grain) or teleplay (slugline-grain) output, runs the
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

  // Fall back to the series' configured LLM when the client doesn't pass an
  // explicit override — every Pipeline LLM action should honor the
  // provider/model picked in the issue header (which mirrors series.llm).
  // Canon lives on the linked universe (Phase B.4). Orphan series render
  // with empty canon — extractScenes can still produce scenes from the
  // source text alone, just without character/place/object grounding.
  const canon = await getSeriesCanon(series);
  const result = await extractScenes({
    source,
    sourceKind,
    characters: canon.characters,
    places: canon.places,
    objects: canon.objects,
    work: { title: issue.title, kind: 'tv-episode' },
    series: { name: series.name, styleNotes: series.styleNotes },
    issue: { number: issue.number, title: issue.title },
    providerOverride: body.providerOverride || series.llm?.provider || undefined,
    modelOverride: body.modelOverride || series.llm?.model || undefined,
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

  const { pages, coverConcept, backCoverConcept } = parseComicScript(source);

  // Preserve a user-edited cover / back-cover script if one is already set —
  // only seed from the parsed concept when the slot is currently blank.
  // Otherwise an extract re-run would clobber a hand-curated cover/back. When
  // we DO seed, also clear any prior imageJobId / prompt — they were
  // rendered against the old (likely placeholder / fallback) script, so
  // leaving them would show a rendered image that doesn't match the new
  // concept text.
  //
  // The decision is made inside updateStageWithLatest so it reads the
  // freshest persisted cover/back, not the stale snapshot from the
  // getIssue read above. A concurrent cover/render call that writes
  // imageJobId between the two awaits would otherwise be silently
  // overwritten.
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    issue.id,
    'comicPages',
    (currentStage) => {
      const currentCoverScript = currentStage?.cover?.script || '';
      const nextCover = coverConcept && !currentCoverScript
        ? { script: coverConcept, imageJobId: null, prompt: null }
        : currentStage?.cover ?? null;
      const currentBackScript = currentStage?.backCover?.script || '';
      const nextBackCover = backCoverConcept && !currentBackScript
        ? { script: backCoverConcept, imageJobId: null, prompt: null }
        : currentStage?.backCover ?? null;
      return {
        status: pages.length ? 'ready' : 'empty',
        pages,
        cover: nextCover,
        backCover: nextBackCover,
        errorMessage: '',
      };
    },
  );

  const panelCount = pages.reduce((n, p) => n + (p.panels?.length || 0), 0);
  res.json({
    issue: updatedIssue,
    stage,
    pageCount: pages.length,
    panelCount,
  });
}));

// Auto-extract runs only after `prose` (textStages.js:233); this endpoint
// lets the writer pull canon from a script stage on demand so characters
// introduced only in panel directions or dialogue cues land in the bible.
// Same autoLock + sourceSeriesId stamping as prose extraction so script-
// derived entries survive later AI refines.
router.post('/issues/:id/stages/:stageId/extract-canon', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (stageId !== 'comicScript' && stageId !== 'teleplay') {
    throw new ServerError(
      `Stage "${stageId}" does not support canon extraction — supported: comicScript, teleplay`,
      { status: 400, code: 'PIPELINE_CANON_EXTRACT_BAD_STAGE' },
    );
  }
  const body = validateRequest(extractCanonFromScriptSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(id).catch((err) => { throw mapServiceError(err); });
  const rawCorpus = (issue.stages?.[stageId]?.output || '').trim();
  if (!rawCorpus) {
    throw new ServerError(
      `Cannot extract canon — issue's ${stageId} stage is empty`,
      { status: 400, code: 'PIPELINE_CANON_EXTRACT_NO_CORPUS' },
    );
  }
  const truncated = rawCorpus.length > EXTRACT_CANON_CORPUS_MAX;
  const corpus = truncated ? rawCorpus.slice(0, EXTRACT_CANON_CORPUS_MAX) : rawCorpus;
  if (truncated) {
    console.warn(`⚠️ Pipeline canon extract — issue=${id.slice(0, 8)} stage=${stageId} corpus truncated ${rawCorpus.length}→${EXTRACT_CANON_CORPUS_MAX}`);
  }
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });
  if (!series.universeId) {
    throw new ServerError(
      `Cannot extract canon — series has no linked universe. Link a universe in the series settings first.`,
      { status: 400, code: 'PIPELINE_CANON_EXTRACT_NO_UNIVERSE' },
    );
  }
  const result = await extractCanonFromProse(series.universeId, {
    corpus,
    // Fall back to the series' configured LLM when the client doesn't pass
    // an explicit override — matches every other Pipeline LLM action
    // (e.g. storyboards/extract-scenes) so a manual extract honors the
    // provider picked in the series header instead of the global default.
    providerOverride: body.providerOverride || series.llm?.provider || undefined,
    parallel: true,
    autoLock: true,
    sourceSeriesId: series.id,
  }).catch((err) => { throw mapServiceError(err); });

  res.json({
    universe: result.universe,
    extracted: countExtractedCanon(result.results),
    sourceStage: stageId,
    truncated,
  });
}));

// Per-page rawText patch — re-parses panels from the edited markdown so a
// subsequent render still gets a structured prompt. Page's `imageJobId` is
// preserved so the user doesn't lose an in-flight render after a save.
//
// The splice + per-panel imageJobId preservation runs inside
// updateStageWithLatest's computeFn so it reads the freshest persisted pages
// array. A concurrent page-level render that lands between a pre-queue read
// and our write would otherwise be reverted — including the imageJobId it
// just queued.
router.patch('/issues/:id/stages/comicPages/pages/:pageIndex', asyncHandler(async (req, res) => {
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const body = validateRequest(comicPagePatchSchema, req.body ?? {});
  const { pages: reparsed } = parseComicScript(body.rawText);
  const fresh = reparsed[0] || { panels: [], rawText: body.rawText };

  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'comicPages',
    (currentStage) => {
      const currentPages = Array.isArray(currentStage?.pages) ? currentStage.pages : [];
      if (!currentPages[pageIndex]) {
        throw new ServerError(
          `pageIndex ${pageIndex} out of range — comicPages has ${currentPages.length} page${currentPages.length === 1 ? '' : 's'}`,
          { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
        );
      }
      const nextPages = [...currentPages];
      nextPages[pageIndex] = {
        ...currentPages[pageIndex],
        rawText: fresh.rawText || body.rawText,
        panels: fresh.panels.map((p, i) => ({
          ...p,
          // Preserve in-flight per-panel jobIds against the freshest panels.
          imageJobId: currentPages[pageIndex].panels?.[i]?.imageJobId ?? p.imageJobId ?? null,
        })),
      };
      return { status: 'edited', pages: nextPages };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, page: stage.pages[pageIndex] });
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
router.post('/issues/:id/stages/comicPages/cover/render', asyncHandler(async (req, res) => {
  const body = validateRequest(comicCoverRenderSchema, req.body ?? {});
  // Make sure the issue exists up front — defense in depth + clean 404
  // before we spend the bible-context load.
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });

  const result = await enqueueComicCover(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });

  // Seed the in-flight render into the matching slot. The filename hook
  // stamps `filename` on completion; `filename: null` here lets the UI
  // render an "in-flight" thumb without showing the previous render's
  // image while the new job is running.
  const slotKey = slotKeyForVariant(result.variant);
  const slotRecord = buildRenderSlot({
    slotKey, jobId: result.jobId, prompt: result.prompt,
    width: body.width, height: body.height, fromProof: result.fromProof,
  });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'comicPages',
    (currentStage) => {
      const currentCover = currentStage?.cover || {};
      return {
        cover: {
          ...currentCover,
          script: result.coverScript || '',
          [slotKey]: slotRecord,
        },
      };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ ...result, cover: stage.cover, issue: updatedIssue, stage });
}));

// Render the comic-issue BACK cover. Same flow as the front-cover route;
// differs in the prompt (no masthead, explicit no-text negative) and the
// persisted slot (`stages.comicPages.backCover.{proofImage|finalImage}`).
router.post('/issues/:id/stages/comicPages/back-cover/render', asyncHandler(async (req, res) => {
  const body = validateRequest(comicBackCoverRenderSchema, req.body ?? {});
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });

  const result = await enqueueComicBackCover(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });

  const slotKey = slotKeyForVariant(result.variant);
  const slotRecord = buildRenderSlot({
    slotKey, jobId: result.jobId, prompt: result.prompt,
    width: body.width, height: body.height, fromProof: result.fromProof,
  });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'comicPages',
    (currentStage) => {
      const currentBack = currentStage?.backCover || {};
      return {
        backCover: {
          ...currentBack,
          script: result.backCoverScript || '',
          [slotKey]: slotRecord,
        },
      };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ ...result, backCover: stage.backCover, issue: updatedIssue, stage });
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
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  if (!pages[pageIndex]) {
    throw new ServerError(
      `pageIndex ${pageIndex} out of range — comicPages has ${pages.length} page${pages.length === 1 ? '' : 's'}`,
      { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
    );
  }

  const result = await enqueueVisualComicPage(req.params.id, { pageIndex, ...body })
    .catch((err) => { throw mapServiceError(err); });

  // The splice happens inside updateStageWithLatest's computeFn so the
  // slot lands on the freshest persisted pages array — a concurrent page
  // edit or sibling render that wrote between our enqueue and persist
  // would otherwise be reverted by a stale snapshot.
  const slotKey = slotKeyForVariant(result.variant);
  const slotRecord = buildRenderSlot({
    slotKey, jobId: result.jobId, prompt: result.prompt,
    width: body.width, height: body.height, fromProof: result.fromProof,
  });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'comicPages',
    (currentStage) => {
      const currentPages = Array.isArray(currentStage?.pages) ? currentStage.pages : [];
      if (!currentPages[pageIndex]) {
        throw new ServerError(
          `pageIndex ${pageIndex} out of range — comicPages has ${currentPages.length} page${currentPages.length === 1 ? '' : 's'}`,
          { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
        );
      }
      const nextPages = [...currentPages];
      nextPages[pageIndex] = {
        ...currentPages[pageIndex],
        [slotKey]: slotRecord,
      };
      return { status: 'edited', pages: nextPages };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ ...result, issue: updatedIssue, stage });
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

// Render the start-frame image for a single shot inside a storyboard scene.
// Shot-level granularity sits parallel to the existing scene-level image
// render: a scene either has shots[] (per-shot images) or doesn't (per-scene
// image). Caller persists the jobId on `scene.shots[shotIndex].startFrameJobId`;
// the storyboards filename hook later stamps `startFrameFilename` on
// completion.
router.post(
  '/issues/:id/stages/storyboards/scenes/:sceneIndex/shots/:shotIndex/render',
  asyncHandler(async (req, res) => {
    const sceneIndex = Number(req.params.sceneIndex);
    const shotIndex = Number(req.params.shotIndex);
    if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || !Number.isInteger(shotIndex) || shotIndex < 0) {
      throw new ServerError('sceneIndex and shotIndex must be non-negative integers', {
        status: 400, code: 'PIPELINE_SHOT_BAD_INDEX',
      });
    }
    const body = validateRequest(comicPageRenderSchema, req.body ?? {});
    const result = await enqueueStoryboardShotStartFrame(req.params.id, sceneIndex, shotIndex, body)
      .catch((err) => { throw mapServiceError(err); });
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
