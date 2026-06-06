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
  optionalBooleanMap,
} from '../lib/validation.js';

import * as seriesSvc from '../services/pipeline/series.js';
import * as issuesSvc from '../services/pipeline/issues.js';
import * as seasonsSvc from '../services/pipeline/seasons.js';
import * as arcPlanner from '../services/pipeline/arcPlanner.js';
import * as manuscriptReview from '../services/pipeline/manuscriptReview.js';
import * as manuscriptFix from '../services/pipeline/manuscriptFix.js';
import { generateStage } from '../services/pipeline/textStages.js';
import * as autoRunner from '../services/pipeline/autoRunner.js';
import * as editorialAnalysis from '../services/pipeline/editorialAnalysis.js';
import * as editorialRunner from '../services/pipeline/editorialAnalysisRunner.js';
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
import { extractCanonFromProse, summarizeCanonExtraction } from '../services/universeCanon.js';
import { getSeriesCanon } from '../services/pipeline/seriesCanon.js';
import { findDuplicateSeriesGroups, findSameNameSeries } from '../services/duplicateDetection.js';
import { mergeSeries, buildCascadeContext } from '../services/recordMerge.js';
import { mergeFieldsWithAI } from '../services/recordMergeAI.js';
import { startEpisodeVideoForIssue, ERR_NO_STORYBOARDS } from '../services/pipeline/episodeVideo.js';
import { generateSeriesTitleLogo } from '../services/pipeline/seriesTitleLogo.js';
import { COMIC_PAGE_VARIANTS, slotKeyForVariant } from '../services/pipeline/owners.js';
import { ASPECT_RATIOS, QUALITIES } from '../lib/creativeDirectorPresets.js';
import { IMAGE_GEN_MODE } from '../services/imageGen/modes.js';
import { extractScenes, SOURCE_KIND } from '../lib/sceneExtractor.js';
import { resolveSeriesLlmOverride } from '../lib/seriesLlmOverride.js';
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
import {
  generateMusic,
  ENGINES,
  DEFAULT_ENGINE_ID,
  isEngineReady,
} from '../services/pipeline/musicGen.js';
import { deriveAudioCues, preserveRenderedCues } from '../services/pipeline/audioCues.js';
import { uploadSingle } from '../lib/multipart.js';
import { parseComicScript } from '../lib/comicScriptParser.js';
import {
  LENGTH_PROFILE_NAMES,
  CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX,
} from '../lib/issueLength.js';
import { llmSchema } from './universeBuilder.js';
import { ARC_LIMITS, ARC_STATUSES, ARC_SHAPE_IDS, ARC_ROLES, SEASON_STATUSES } from '../lib/storyArc.js';

// Inline until better/code-quality lands and exports this from validation.js
const issuesListQuerySchema = z.object({
  offset: z.preprocess((v) => (v === undefined ? 0 : Number(v)), z.number().int().min(0)).default(0),
  limit: z.preprocess((v) => (v === undefined ? 1000 : Number(v)), z.number().int().min(1).max(1000)).default(1000),
});

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
  [manuscriptFix.ERR_VALIDATION]: 400,
  [manuscriptFix.ERR_NOT_FOUND]: 404,
  PIPELINE_REVIEW_NOT_FOUND: 404,
  [ERR_NO_STORYBOARDS]: 400,
  [ERR_NO_RENDERED_PAGES]: 409,
  [ERR_NO_VOLUME_COVER]: 409,
  [ERR_NO_RENDERED_ISSUES]: 409,
  // recordMerge validation (unresolved conflicts, bad ids, cross-universe).
  MERGE_VALIDATION: 400,
  // recordMerge cascade partially completed (the issue reassign failed) → 409 so
  // the client can surface "merge incomplete, re-run to finish".
  MERGE_CASCADE_INCOMPLETE: 409,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) {
    // An incomplete merge cascade forwards the survivor/loser ids + which step
    // failed so the UI can tell the user exactly what didn't move.
    return new ServerError(err.message, { status, code: err.code, context: buildCascadeContext(err) });
  }
  return err;
};

// ---- Series schemas ----
//
// Canon (characters / places / objects) is no longer carried on a series
// payload — it lives on the linked universe (Phase B.4). The bible-entry
// Zod shapes (`characterSchema` et al.) and the `BIBLE_KIND` plumbing moved
// out of this file when the series-side canon routes were retired.

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
  // Reader map (audience-experience roadmap). Accepted as an opaque object and
  // validated/sanitized server-side by sanitizeReaderMap (storyArc.js) — mirrors
  // how visualStageInputSchema defers artifact validation to the service. Must
  // be listed here or Zod's default key-stripping would silently drop it on any
  // arc PATCH, and updateSeries's wholesale arc replace would then wipe it.
  readerMap: z.object({}).passthrough().nullable().optional(),
  status: z.enum(ARC_STATUSES).optional(),
});

// Volume-cover / back-cover sub-schema — accepts the script text plus the
// pre-split legacy fields. Render-slot details (`proofImage`, `finalImage`)
// arrive only from the render route's PATCH path, which builds them
// server-side; PATCHes of the season metadata only carry the user-editable
// `script`. `.passthrough()` keeps the door open for a "save full series"
// round-trip echoing back server-built render fields (proofImage /
// finalImage) without 400'ing — the parent seasonSchema is already
// passthrough for the same reason.
const seasonCoverSchema = z.object({
  script: z.string().max(8000).optional(),
  imageJobId: z.string().trim().max(200).nullable().optional(),
  prompt: z.string().max(16_000).nullable().optional(),
}).passthrough();

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

// `.passthrough` keeps the door open for future per-season locks without a
// schema bump — the series sanitizer is the source of truth. `arcFields`
// holds the per-field arc locks (logline / summary / themes / etc.) that
// `commitSeasonsWithRemap` honors when rewriting `series.arc`.
const seriesLockedSchema = z.object({
  ...optionalBooleanMap(seriesSvc.LOCKABLE_STAGES),
  arcFields: z.object(optionalBooleanMap(seriesSvc.ARC_LOCKABLE_FIELDS)).optional(),
}).passthrough();

const seriesCreateSchema = z.object({
  name: z.string().trim().min(1).max(seriesSvc.NAME_MAX),
  logline: z.string().trim().max(seriesSvc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(seriesSvc.PREMISE_MAX).optional().default(''),
  // Series in PortOS are expected to be linked to a universe — canon
  // (characters, places, objects, style) lives on the universe and an
  // orphan series has nothing to render against. The UI's create form
  // enforces this; the route stays permissive so the importer and
  // share-bucket sync paths (which preserve remote data fidelity) can
  // still land legacy orphans.
  universeId: z.string().trim().max(seriesSvc.UNIVERSE_ID_MAX).nullable().optional(),
  writersRoomWorkId: z.string().trim().max(seriesSvc.WRITERS_ROOM_WORK_ID_MAX).nullable().optional(),
  arc: arcSchema.nullable().optional(),
  seasons: z.array(seasonSchema).max(ARC_LIMITS.SEASONS_PER_SERIES_MAX).optional(),
  locked: seriesLockedSchema.optional(),
  styleNotes: z.string().trim().max(seriesSvc.STYLE_NOTES_MAX).optional().default(''),
  titleLogo: z.string().trim().max(seriesSvc.TITLE_LOGO_MAX).optional().default(''),
  author: z.string().trim().max(seriesSvc.AUTHOR_MAX).optional().default(''),
  stylePromptOverride: z.string().trim().max(seriesSvc.STYLE_PROMPT_OVERRIDE_MAX).optional().default(''),
  stylePromptOverrideMode: z.enum(seriesSvc.STYLE_PROMPT_OVERRIDE_MODES).optional(),
  targetFormat: z.enum(seriesSvc.TARGET_FORMATS).optional(),
  primaryManuscriptType: z.enum(seriesSvc.MANUSCRIPT_TYPES).nullable().optional(),
  issueCountTarget: z.number().int().min(0).max(seriesSvc.ISSUE_COUNT_TARGET_MAX).optional(),
  llm: llmSchema,
  // Local-only "don't sync to peers" marker.
  ephemeral: z.boolean().optional(),
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
  stylePromptOverrideMode: z.enum(seriesSvc.STYLE_PROMPT_OVERRIDE_MODES).optional(),
  targetFormat: z.enum(seriesSvc.TARGET_FORMATS).optional(),
  primaryManuscriptType: z.enum(seriesSvc.MANUSCRIPT_TYPES).nullable().optional(),
  issueCountTarget: z.number().int().min(0).max(seriesSvc.ISSUE_COUNT_TARGET_MAX).optional(),
  llm: llmSchema,
  ephemeral: z.boolean().optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });
const arcFieldLockSchema = z.object({ locked: z.boolean() });

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
  ephemeral: z.boolean().optional(),
});

const stageInputSchema = z.object({
  status: z.enum(issuesSvc.STAGE_STATUSES).optional(),
  input: z.string().max(issuesSvc.STAGE_INPUT_MAX).optional(),
  output: z.string().max(issuesSvc.STAGE_OUTPUT_MAX).optional(),
  errorMessage: z.string().max(issuesSvc.STAGE_NOTES_MAX).optional(),
  locked: z.boolean().optional(),
});

// Strict base arm for the stage-record union below — a bare text-stage patch
// (only base fields) validates here, but a payload carrying any visual/audio
// extra key fails this arm and is routed to the matching specific arm instead
// of being silently key-stripped. The non-strict `stageInputSchema` stays the
// `.extend()` base for the specific arms (they re-apply `.strict()` themselves).
const baseStageStrictSchema = stageInputSchema.strict();

// Light per-cue arm for the audio stage (issue #863). The service-side
// `sanitizeAudioCue` enforces the real shape (ids, time sentinels, gain clamp);
// here we only bound sizes so a corrupt payload can't balloon the request.
const audioCueInputSchema = z.object({
  id: z.string().trim().max(issuesSvc.AUDIO_CUE_ID_MAX).optional(),
  label: z.string().max(issuesSvc.AUDIO_CUE_LABEL_MAX).nullable().optional(),
  prompt: z.string().max(issuesSvc.AUDIO_CUE_PROMPT_MAX).nullable().optional(),
  engine: z.string().trim().max(issuesSvc.AUDIO_CUE_ENGINE_MAX).nullable().optional(),
  startSec: z.number().nullable().optional(),
  endSec: z.number().nullable().optional(),
  trackFilename: z.string().trim().max(issuesSvc.AUDIO_FILENAME_MAX).nullable().optional(),
  durationSec: z.number().nullable().optional(),
  gain: z.number().nullable().optional(),
}).strip();

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
    imageMode: z.enum(['auto', IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX]).optional(),
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
}).strict();

// Audio stage payloads carry lines[] (voice-over per dialogue line), a nullable
// music descriptor, the whole-episode `audioMode` selector, and arc-driven
// `cues[]` (issue #863). Light validation — the sanitizer in
// services/pipeline/issues.js enforces per-line / per-music / per-cue shape.
// Without this arm in the union below, audio PATCHes fall through and the
// base/visual arms strip lines/music/audioMode/cues.
//
// `.strict()` is load-bearing here: the union arms below all share the same
// optional base fields, so a plain object parses against *any* arm and Zod's
// default key-stripping would let an audio payload match the visual arm FIRST,
// silently dropping audioMode/cues. Strict arms reject unknown keys, so an
// audio payload (with audioMode/cues/lines/music) only validates against THIS
// arm and reaches the audio sanitizer intact.
const audioStageInputSchema = stageInputSchema.extend({
  lines: z.array(z.any()).max(1000).optional(),
  music: z.any().nullable().optional(),
  audioMode: z.enum(issuesSvc.AUDIO_MODES).optional(),
  cues: z.array(audioCueInputSchema).max(issuesSvc.AUDIO_CUES_MAX).optional(),
}).strict();

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
  // Stage-record arms are all `.strict()` (see audioStageInputSchema above):
  // every arm shares the same optional base fields, so a non-strict arm would
  // accept (and key-strip) a payload meant for a sibling arm. With strict arms
  // a payload only validates against the arm whose extra keys it actually
  // carries — visual payloads (pages/scenes/…) reach the visual arm, audio
  // payloads (lines/music/audioMode/cues) reach the audio arm, and bare
  // text-stage patches (status/output/locked only) fall through to the base.
  // Order is now defensive rather than load-bearing, but we still place the
  // more-specific arms first; the bare base last.
  stages: z.record(z.string(), z.union([visualStageInputSchema, audioStageInputSchema, baseStageStrictSchema])).optional(),
  ephemeral: z.boolean().optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const generateSchema = z.object({
  seedInput: z.string().max(issuesSvc.STAGE_INPUT_MAX).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  // Explicit source stages to feed the generation (backport support: generate
  // any stage FROM any other populated stage). Omit for the conventional
  // forward source. The service drops the target itself and empty stages.
  sourceStageIds: z.array(z.enum(issuesSvc.TEXT_STAGE_IDS)).optional(),
});

const visualGenerateSchema = z.object({
  description: z.string().trim().min(1).max(8000),
  // Matched against the series places bible when present.
  slugline: z.string().trim().max(200).optional(),
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
  // Per-scene wardrobe picks threaded from the storyboards UI — the generic
  // visual route has no scene index, so the client sends the selected
  // appearances directly. Each pins one canon character to one of its
  // wardrobes; the prompt builder appends the wardrobe after the character's
  // physical description.
  characterAppearances: z.array(z.object({
    characterId: z.string().trim().min(1).max(120),
    wardrobeId: z.string().trim().min(1).max(120).nullable().optional(),
  })).max(50).optional(),
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

// Full-comic-page render: same knobs as panel render minus `description` /
// `slugline` (the prompt is built server-side from the page's panels[] so it
// stays in sync with whatever the script-extractor produced).
const comicPageRenderSchema = z.object({
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
  model: z.string().trim().max(128).optional(),
});

// Stages whose `output` can be mined for canon. `prose` is the conventional
// source (auto-extracted post-generation); `comicScript`/`teleplay` let the
// writer pull characters introduced only in panel directions / dialogue cues.
const CANON_EXTRACT_STAGES = Object.freeze(['prose', 'comicScript', 'teleplay']);

// Per-issue truncation budget for canon extraction. Decoupled from the
// importer's source ceiling (which ingests a *whole book* — millions of
// chars): a pipeline issue's stage output is already hard-bounded at
// `STAGE_OUTPUT_MAX` (400KB), so this path operates at a fundamentally
// smaller scale. 200K clamps a long single-issue script before forwarding
// to the same `extractBible` machinery the importer uses, keeping the
// per-call corpus comfortably inside provider context windows.
const EXTRACT_CANON_CORPUS_MAX = 200_000;

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

// Back-derive arc/bible/structure from the existing issue manuscripts. The
// preview pass just needs the override shape; the commit pass carries the
// (possibly user-edited) proposal so the LLM is NOT re-run on confirm.
const arcDeriveSchema = z.object(providerOverrideShape);
const arcDeriveCommitSchema = z.object({
  arc: z.object({
    logline: z.string().max(500).optional(),
    summary: z.string().max(8000).optional(),
    protagonistArc: z.string().max(8000).optional(),
    themes: z.array(z.string().max(200)).max(50).optional(),
    shape: z.string().max(80).nullable().optional(),
  }).optional(),
  bible: z.object({
    logline: z.string().max(500).optional(),
    premise: z.string().max(8000).optional(),
    issueCountTarget: z.number().int().min(0).max(9999).optional(),
  }).optional(),
  volume: z.object({
    title: z.string().max(300).optional(),
    logline: z.string().max(1000).optional(),
    synopsis: z.string().max(8000).optional(),
  }).optional(),
  issues: z.array(z.object({
    id: z.string().min(1).max(120),
    title: z.string().max(300).optional(),
    synopsis: z.string().max(8000).optional(),
  })).max(200).optional(),
});

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

// Editorial reader-emotion analysis — provider/model optional (falls through
// to the active or stage-pinned provider); `force` re-analyzes unchanged issues.
const editorialAnalyzeSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  force: z.boolean().optional(),
});

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
  issuesSvc.assertStageUnlocked(issue, 'audio');
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
  // Per-line VO start offset (seconds into the stitched episode). null clears
  // the placement so the muxer skips the line. The sanitizer clamps the range.
  offsetSec: z.number().min(0).max(7200).nullable().optional(),
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
      if ('offsetSec' in body) next.offsetSec = body.offsetSec;
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
  issuesSvc.assertStageUnlocked(issue, 'audio');
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
const audioStatusAfterMusicChange = (stage) =>
  (stage.lines?.length ? 'edited' : 'empty');

// Attaching/generating/uploading a single track means "use this one track as
// the episode bed" — flip audioMode to 'uploaded-track' so the stitcher
// actually muxes it. Without this a new issue stays at the default 'per-clip'
// mode, which (correctly) ignores the music pointer, so the track would land on
// the issue but never play (issue #863). Only override the generated/silent
// modes when the user explicitly attaches a single track — those are deliberate
// strategy choices we shouldn't silently undo for an unrelated music write... but
// since all three routes ARE the "set the single track" action, the override is
// the user's intent. The delete route mirrors this: clearing the only track
// reverts an 'uploaded-track' issue to 'per-clip', leaving generated/silent be.
const audioModeAfterTrackSet = () => 'uploaded-track';
const audioModeAfterTrackClear = (stage) =>
  (stage.audioMode === 'uploaded-track' ? 'per-clip' : stage.audioMode);

router.get('/audio/music-library', asyncHandler(async (_req, res) => {
  res.json({ tracks: await listMusicLibrary() });
}));

// Local-OSS music generators available to the audio stage (Phase 4c.2).
// Returns every selectable backend under `engines` (each carrying its models,
// duration window and a `ready` flag for the opt-in venv) plus a `defaultEngine`
// id. The top-level `models`/`ready`/duration fields mirror the default engine
// for backward compatibility with pre-multi-engine clients.
router.get('/audio/music/generators', asyncHandler(async (_req, res) => {
  const engines = Object.values(ENGINES).map((engine) => ({
    id: engine.id,
    name: engine.name,
    models: engine.models.map(({ id, name }) => ({ id, name })),
    defaultModelId: engine.defaultModelId,
    defaultDurationSec: engine.defaultDurationSec,
    minDurationSec: engine.minDurationSec,
    maxDurationSec: engine.maxDurationSec,
    // The authoritative install-hint env var (e.g. INSTALL_AUDIOLDM2) so the UI
    // renders the exact command instead of re-deriving it from the engine id.
    installEnv: engine.installEnv,
    ready: isEngineReady(engine.id),
  }));
  const fallback = engines.find((e) => e.id === DEFAULT_ENGINE_ID) ?? engines[0];
  res.json({
    engines,
    defaultEngine: DEFAULT_ENGINE_ID,
    // Back-compat: flatten the default engine's fields to the top level.
    models: fallback.models,
    defaultModelId: fallback.defaultModelId,
    defaultDurationSec: fallback.defaultDurationSec,
    minDurationSec: fallback.minDurationSec,
    maxDurationSec: fallback.maxDurationSec,
    ready: fallback.ready,
  });
}));

// Every model id across all engines — the schema validates `modelId` against
// this union and `generateMusic` resolves it within the chosen engine (falling
// back to that engine's default for a mismatched id).
const ALL_MODEL_IDS = Object.values(ENGINES).flatMap((e) => e.models.map((m) => m.id));
// The widest duration window across engines; per-engine clamping happens in the
// service, so the schema just rejects absurd values.
const MAX_ENGINE_DURATION = Math.max(...Object.values(ENGINES).map((e) => e.maxDurationSec));

// Generate a background-music track with the selected backend and attach it to
// the issue as a `source: 'gen'` track. The generated WAV lands in the shared
// music library, so it's reusable across issues exactly like an upload.
const musicGenerateSchema = z.object({
  prompt: z.string().trim().min(1).max(800),
  engine: z.enum(Object.keys(ENGINES)).optional(),
  durationSec: z.number().min(1).max(MAX_ENGINE_DURATION).optional(),
  modelId: z.enum(ALL_MODEL_IDS).optional(),
});
router.post('/issues/:id/stages/audio/music/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(musicGenerateSchema, req.body ?? {});
  // Guard the (expensive) generation behind a 404 check first — generating a
  // multi-second clip only to discover the issue is gone wastes GPU time and
  // would orphan the WAV in the library.
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'audio');
  const gen = await generateMusic({
    prompt: body.prompt,
    engine: body.engine ?? DEFAULT_ENGINE_ID,
    durationSec: body.durationSec,
    modelId: body.modelId,
  }).catch((err) => { throw mapServiceError(err); });
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => ({
      status: audioStatusAfterMusicChange(current),
      audioMode: audioModeAfterTrackSet(),
      music: { source: MUSIC_SOURCE.GEN, trackFilename: gen.filename, label: gen.model },
      errorMessage: '',
    }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, music: stage.music, durationSec: gen.durationSec, modelId: gen.modelId, engine: gen.engine });
}));

router.post('/issues/:id/stages/audio/music/upload', musicUpload, asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ServerError('No audio file uploaded', {
      status: 400, code: 'PIPELINE_MUSIC_NO_FILE',
    });
  }
  // Guard the filesystem write that follows — `updateStageWithLatest`'s 404
  // would otherwise orphan the imported file in the music library.
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const { filename, sizeBytes } = await importUploadedTrack(req.file.path, req.file.originalname);
  const label = typeof req.body?.label === 'string' && req.body.label.trim()
    ? req.body.label.trim()
    : null;
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => ({
      status: audioStatusAfterMusicChange(current),
      audioMode: audioModeAfterTrackSet(),
      music: { source: MUSIC_SOURCE.UPLOAD, trackFilename: filename, label },
      errorMessage: '',
    }),
  ).catch((err) => { throw mapServiceError(err); });
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
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => ({
      status: audioStatusAfterMusicChange(current),
      audioMode: audioModeAfterTrackSet(),
      music: {
        source: MUSIC_SOURCE.LIBRARY,
        trackFilename: body.trackFilename,
        label: body.label?.trim() || found.label,
      },
      errorMessage: '',
    }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage, music: stage.music });
}));

router.delete('/issues/:id/stages/audio/music', asyncHandler(async (req, res) => {
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => ({
      status: audioStatusAfterMusicChange(current),
      audioMode: audioModeAfterTrackClear(current),
      music: null,
      errorMessage: '',
    }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({ issue: updatedIssue, stage });
}));

// Whole-episode audio cues (issue #863, step 3). The 'generated' audioMode lays
// an ordered cues[] array — one cue per narrative arc beat — onto the episode
// timeline at stitch time. These two routes derive the cue list from the
// episode's own beats and render each cue's audio.

// Derive the per-arc cue list from the episode's OWN beat prose (stages.idea) +
// storyboard scene order. Replaces the existing cues[] unless force is false and
// cues already exist (mirrors the extract-lines / extract-scenes overwrite
// guard). Already-rendered cue audio is carried forward by label so re-deriving
// doesn't silently invalidate every rendered WAV.
const cuesGenerateSchema = z.object({
  engine: z.enum(Object.keys(ENGINES)).optional(),
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(128).optional(),
  force: z.boolean().optional(),
});
router.post('/issues/:id/stages/audio/cues/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(cuesGenerateSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'audio');
  const existing = Array.isArray(issue.stages?.audio?.cues) ? issue.stages.audio.cues : [];
  if (existing.length > 0 && !body.force) {
    throw new ServerError(
      `Audio stage already has ${existing.length} cue${existing.length === 1 ? '' : 's'} — pass { force: true } to replace`,
      { status: 409, code: 'PIPELINE_AUDIO_CUES_EXIST' },
    );
  }
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });
  // Inherit the series LLM unless the client overrides — same provider/model
  // resolution as the other Pipeline LLM actions (extract-scenes / extract-canon).
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: body.providerOverride,
    overrideModel: body.modelOverride,
  });
  const result = await deriveAudioCues(issue, {
    defaultEngine: body.engine ?? DEFAULT_ENGINE_ID,
    providerOverride: provider,
    modelOverride: model,
    series: { name: series.name, styleNotes: series.styleNotes },
  }).catch((err) => { throw mapServiceError(err); });
  // Carry forward already-rendered cue audio (matched by label) so a re-derive
  // doesn't drop WAVs the user already generated.
  const cues = preserveRenderedCues(result.cues, existing);
  // Deriving cues implies the user wants the episode-level generated soundtrack —
  // flip audioMode to 'generated' so the muxer picks up the cues at stitch time.
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    () => ({ audioMode: 'generated', cues, lastRunId: result.runId, errorMessage: '' }),
  ).catch((err) => { throw mapServiceError(err); });
  res.json({
    issue: updatedIssue, stage,
    cues: stage.cues,
    cueCount: stage.cues.length,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
  });
}));

// Render one cue's audio via the generator-agnostic generateMusic contract,
// stamping trackFilename + durationSec back into that cue. Mirrors the per-line
// render route. The duration is the cue's placed timeline span (endSec-startSec)
// when placed, else the requested durationSec, else the engine default —
// per-engine clampDuration in generateMusic guards the final value.
const cueRenderSchema = z.object({
  engine: z.enum(Object.keys(ENGINES)).optional(),
  durationSec: z.number().min(1).max(MAX_ENGINE_DURATION).optional(),
  modelId: z.enum(ALL_MODEL_IDS).optional(),
});
router.post('/issues/:id/stages/audio/cues/:cueIdx/render', asyncHandler(async (req, res) => {
  const cueIdx = Number(req.params.cueIdx);
  if (!Number.isInteger(cueIdx) || cueIdx < 0) {
    throw new ServerError('cueIdx must be a non-negative integer', {
      status: 400, code: 'PIPELINE_AUDIO_BAD_INDEX',
    });
  }
  const body = validateRequest(cueRenderSchema, req.body ?? {});
  // Guard the expensive generation behind a 404 + range check first so we don't
  // burn GPU time only to discover the issue/cue is gone (orphaning the WAV).
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'audio');
  const cues = Array.isArray(issue.stages?.audio?.cues) ? issue.stages.audio.cues : [];
  const cue = cues[cueIdx];
  if (!cue) {
    throw new ServerError(`cueIdx ${cueIdx} out of range (have ${cues.length})`, {
      status: 404, code: 'PIPELINE_AUDIO_CUE_NOT_FOUND',
    });
  }
  if (!cue.prompt) {
    throw new ServerError('Cue has no prompt to render — derive cues first', {
      status: 400, code: 'PIPELINE_AUDIO_CUE_NO_PROMPT',
    });
  }
  // Duration priority: an explicit body override → the placed timeline span
  // (endSec-startSec when both are placed) → the engine default (generateMusic
  // resolves undefined to the engine's defaultDurationSec). Engine resolution
  // priority: body → the cue's own engine hint → the global default.
  const span = (typeof cue.startSec === 'number' && typeof cue.endSec === 'number' && cue.endSec > cue.startSec)
    ? cue.endSec - cue.startSec
    : undefined;
  const engine = body.engine ?? cue.engine ?? DEFAULT_ENGINE_ID;
  const gen = await generateMusic({
    prompt: cue.prompt,
    engine,
    durationSec: body.durationSec ?? span,
    modelId: body.modelId,
  }).catch((err) => { throw mapServiceError(err); });
  // Merge against the freshest persisted cue inside the write queue so a
  // concurrent re-derive can't clobber the render (the cue list is re-read here).
  const { issue: updatedIssue, stage } = await issuesSvc.updateStageWithLatest(
    req.params.id,
    'audio',
    (current) => {
      const curCues = Array.isArray(current?.cues) ? current.cues : [];
      const target = curCues[cueIdx];
      if (!target) return {};
      const nextCues = [...curCues];
      nextCues[cueIdx] = {
        ...target,
        engine: gen.engine,
        trackFilename: gen.filename,
        durationSec: gen.durationSec,
      };
      return { cues: nextCues, errorMessage: '' };
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({
    issue: updatedIssue, stage, cueIdx,
    cue: stage.cues[cueIdx],
    trackFilename: gen.filename,
    durationSec: gen.durationSec,
    engine: gen.engine,
    modelId: gen.modelId,
  });
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
  // Hierarchy invariant: every series belongs to exactly one universe. Enforce
  // it for all HTTP callers here (the UI already enforces it client-side).
  // The schema stays permissive (nullable) so the importer + mergeSeriesFromSync,
  // which call createSeries directly, can still land legacy orphans from peers.
  if (!body.universeId || !String(body.universeId).trim()) {
    throw new ServerError('A universe is required — a series must belong to a universe.', {
      status: 400, code: seriesSvc.ERR_VALIDATION,
    });
  }
  const created = await seriesSvc.createSeries(body);
  // Non-blocking same-name warning, scoped within the universe (route layer
  // only, so the importer's direct createSeries never pays for the scan).
  const duplicateName = await findSameNameSeries(created.name, created.universeId, { excludeId: created.id });
  res.status(201).json(duplicateName.length ? { ...created, _warnings: { duplicateName } } : created);
}));

// ---- Series duplicate resolution (static paths — keep BEFORE `/series/:id`) ----

const seriesMergeSchema = z.object({
  survivorId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  loserId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  fieldChoices: z.record(z.enum(['survivor', 'loser'])).optional().default({}),
  // Free-form per-field values that win over the survivor/loser binary —
  // populated by the AI-merge flow (a third unified option) and optionally
  // tweaked by the user before submit.
  fieldOverrides: z.record(z.string()).optional().default({}),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

const seriesMergeAIResolveSchema = z.object({
  survivorId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  loserId: z.string().trim().regex(/^ser-/, 'must be a ser-<uuid> id').max(128),
  fields: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

router.get('/series/duplicates', asyncHandler(async (_req, res) => {
  res.json(await findDuplicateSeriesGroups());
}));

router.post('/series/merge/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeSchema, req.body ?? {});
  const preview = await mergeSeries(body.survivorId, body.loserId, body.fieldChoices, { dryRun: true, fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(preview);
}));

router.post('/series/merge', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeSchema, req.body ?? {});
  const result = await mergeSeries(body.survivorId, body.loserId, body.fieldChoices, { fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Ask the configured AI provider to merge specific conflicting text fields
// into a single unified value per field. Same shape as the universe-side
// /universe-builder/merge/ai-resolve route.
router.post('/series/merge/ai-resolve', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeAIResolveSchema, req.body ?? {});
  const [survivor, loser] = await Promise.all([
    seriesSvc.getSeries(body.survivorId).catch((err) => { throw mapServiceError(err); }),
    seriesSvc.getSeries(body.loserId).catch((err) => { throw mapServiceError(err); }),
  ]);
  const result = await mergeFieldsWithAI({
    kind: 'series',
    survivor,
    loser,
    fields: body.fields,
    providerId: body.providerId,
    model: body.model,
  });
  res.json(result);
}));

router.get('/series/:id', asyncHandler(async (req, res) => {
  const s = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(s);
}));

router.patch('/series/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesPatchSchema, req.body ?? {});
  const s = await seriesSvc.updateSeries(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  if ('name' in body || 'universeId' in body) {
    const duplicateName = await findSameNameSeries(s.name, s.universeId, { excludeId: req.params.id });
    if (duplicateName.length) { res.json({ ...s, _warnings: { duplicateName } }); return; }
  }
  res.json(s);
}));

router.patch('/series/:id/arc-fields/:field/lock', asyncHandler(async (req, res) => {
  const body = validateRequest(arcFieldLockSchema, req.body ?? {});
  const s = await seriesSvc.setArcFieldLock(req.params.id, req.params.field, body.locked)
    .catch((err) => { throw mapServiceError(err); });
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
  const hasPagination = req.query.offset !== undefined || req.query.limit !== undefined;
  // List endpoints strip per-stage runHistory; the UI never renders it on
  // these views and a maxed-out issue can otherwise ship ~12MB of payload.
  // Detail reads (`GET /issues/:id`) stay on the full shape.
  if (hasPagination) {
    const { offset, limit } = validateRequest(issuesListQuerySchema, req.query);
    res.json(await issuesSvc.listIssues({ seriesId: req.params.id, offset, limit, paginated: true, withHistory: false }));
  } else {
    res.json(await issuesSvc.listIssues({ seriesId: req.params.id, withHistory: false }));
  }
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

  let createdIssues = [];
  let bibleExtracted = null;
  if (body.commit) {
    // Create one issue per episode under this season. The issue sanitizer
    // already accepts `seasonId` + `arcPosition`; the shared helper owns the
    // per-episode → createIssue mapping so the Story Builder's batch path
    // mints identical issue shapes.
    // Fetch the series once and thread it through both the issue-creation
    // batch (so each createIssue's renumber pass skips a redundant read) and
    // the continuity extraction below.
    const series = await seriesSvc.getSeries(req.params.id).catch(() => null);
    createdIssues = await arcPlanner.commitEpisodesToIssues(
      req.params.id, req.params.seasonId, result.episodes, { preloadedSeries: series },
    );

    // Non-fatal: episode creation already succeeded, so a noisy extraction
    // failure must not invalidate the user's accepted breakdown. Phase B.4:
    // canon lives on the linked universe — orphan series (no universeId)
    // skip extraction.
    const corpus = result.episodes
      .map((ep) => `## E${ep.number} — ${ep.title}\n\n${ep.logline || ''}\n\n${ep.synopsis || ''}`.trim())
      .filter(Boolean)
      .join('\n\n');
    if (corpus.trim() && series?.universeId) {
      // Fall back to the series' configured LLM when the client doesn't pass an
      // explicit override — matches the extract-canon and extract-scenes routes
      // so continuity extraction honors the provider/model picked in the series
      // header instead of the global active provider. A model id is
      // provider-specific, so only inherit the series model when the effective
      // provider is still the series provider; an override that switches
      // providers without naming a model leaves it blank so the new provider's
      // default resolves.
      const { provider, model } = resolveSeriesLlmOverride(series, {
        overrideProvider: body.providerOverride,
        overrideModel: body.modelOverride,
      });
      // Stamp new inserts as series-extracted (autoLock + sourceSeriesId) so
      // continuity-derived canon survives later AI refines and stays
      // attributable to this series. Matches the pre-B.4 series-side
      // extract semantics.
      const extractRes = await extractCanonFromProse(series.universeId, {
        corpus,
        providerOverride: provider,
        modelOverride: model,
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
    throw new ServerError('No active beat-sheet run for this volume', { status: 404 });
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

// Back-derive arc + bible + single-volume restructure from the EXISTING issue
// manuscripts ("I imported a finished graphic novel, reconstruct its spine").
// Read-only preview the UI shows for review/edit before the commit route.
router.post('/series/:id/arc/derive-from-manuscript', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcDeriveSchema, req.body ?? {});
  const result = await arcPlanner.deriveFromManuscript(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Apply the (possibly edited) derive preview: bible + single volume + per-issue
// synopses. The LLM is NOT re-run — the confirmed proposal is in the body.
router.post('/series/:id/arc/derive-from-manuscript/commit', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcDeriveCommitSchema, req.body ?? {});
  const result = await arcPlanner.commitDerivedManuscript(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

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

// =====================
// Manuscript editor — full series manuscript + persisted editorial comments.
// The "manuscript" is virtual: one chosen stage per issue (comicScript ▸
// teleplay ▸ prose) concatenated in story order. Edits target a specific
// issue+stage; comments persist in data/pipeline-series/{id}/manuscript-review.json.
// =====================

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
    // The route's projection below drops `stages` entirely, but pass
    // withHistory: false anyway so the service stays light on a sidebar
    // refresh and the contract matches `GET /series/:id/issues`.
    issuesSvc.listRecentIssues({ limit: req.query.limit, withHistory: false }),
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

// Restore a prior text-stage version from history. See
// issuesSvc.restoreStageFromHistory for the reversibility semantics.
const restoreSchema = z.object({
  runId: z.string().trim().min(1).max(200),
});
router.post('/issues/:id/stages/:stageId/restore', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!issuesSvc.TEXT_STAGE_IDS.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" does not support history restore`,
      { status: 400, code: 'PIPELINE_NON_TEXT_STAGE' },
    );
  }
  const body = validateRequest(restoreSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, stageId);
  const result = await issuesSvc.restoreStageFromHistory(id, stageId, body.runId)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Auto-fill stages.storyboards.scenes[] from a text stage. Reads the issue's
// prose (paragraph-grain) or teleplay (slugline-grain) output, runs the
// shared scene extractor, and replaces stages.storyboards.scenes with the
// result mapped to the storyboards UI shape (visualPrompt → description).
router.post('/issues/:id/stages/storyboards/extract-scenes', asyncHandler(async (req, res) => {
  const body = validateRequest(extractScenesSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  issuesSvc.assertStageUnlocked(issue, 'storyboards');
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
  // A model id is provider-specific, so only inherit the series model when the
  // effective provider is still the series provider — otherwise an override
  // provider would be paired with a foreign model id and fail (same guard as
  // the extract-canon route). When the override switches providers without
  // naming a model, leave it blank so the new provider's default resolves.
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: body.providerOverride,
    overrideModel: body.modelOverride,
  });
  const result = await extractScenes({
    source,
    sourceKind,
    characters: canon.characters,
    places: canon.places,
    objects: canon.objects,
    work: { title: issue.title, kind: 'tv-episode' },
    series: { name: series.name, styleNotes: series.styleNotes },
    issue: { number: issue.number, title: issue.title },
    providerOverride: provider,
    modelOverride: model,
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
  issuesSvc.assertStageUnlocked(issue, 'comicPages');

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
  if (!CANON_EXTRACT_STAGES.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" does not support canon extraction — supported: ${CANON_EXTRACT_STAGES.join(', ')}`,
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
  // Fall back to the series' configured LLM when the client doesn't pass an
  // explicit override — matches every other Pipeline LLM action (e.g.
  // storyboards/extract-scenes) so a manual extract honors the provider/model
  // picked in the series header instead of the global default.
  // A model id is provider-specific. Only inherit the series model when the
  // EFFECTIVE provider is still the series provider — otherwise the retry
  // picker's whole point (switch provider, keep "Default model") would forward
  // e.g. `providerOverride: anthropic` paired with a Codex/OpenAI model id and
  // fail. When the user overrode to a different provider without naming a
  // model, leave it blank so the extractor resolves that provider's default.
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: body.providerOverride,
    overrideModel: body.model,
  });

  // Stamp the outcome on the stage so the Nouns UI can persist a
  // failure/partial banner and the user can retry with a different
  // provider/model. A hard failure (every kind threw) still records `failed`
  // before re-throwing so the banner survives even when the request 5xxes.
  let result;
  try {
    result = await extractCanonFromProse(series.universeId, {
      corpus,
      providerOverride: provider,
      modelOverride: model,
      parallel: true,
      autoLock: true,
      sourceSeriesId: series.id,
    });
  } catch (err) {
    const marker = summarizeCanonExtraction({ error: err, provider, model });
    await issuesSvc.updateStage(id, stageId, { canonExtraction: marker })
      .catch((e) => console.warn(`⚠️ Failed to record canon-extraction status for issue ${id.slice(0, 8)}: ${e.message}`));
    throw mapServiceError(err);
  }

  const marker = summarizeCanonExtraction({ results: result.results, failures: result.failures, provider, model });
  const { issue: stampedIssue } = await issuesSvc.updateStage(id, stageId, { canonExtraction: marker })
    .catch((err) => { throw mapServiceError(err); });

  res.json({
    universe: result.universe,
    issue: stampedIssue,
    canonExtraction: marker,
    failures: result.failures,
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
    throw new ServerError('No active auto-run for this issue', { status: 404 });
  }
});

router.post('/issues/:id/auto-run-text/cancel', asyncHandler(async (req, res) => {
  const canceled = autoRunner.cancelAutoRun(req.params.id);
  res.json({ canceled });
}));

// =====================
// Editorial roadmap / reader-emotion analysis
// =====================

// Aggregate roadmap (Plot / Character / Reader curves + character arcs + coverage)
router.get('/series/:id/editorial', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await editorialAnalysis.getSeriesEditorial(req.params.id));
}));

// Full per-issue snapshot (section-by-section emotion log + character arcs)
router.get('/issues/:id/editorial', asyncHandler(async (req, res) => {
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const analysis = await editorialAnalysis.getIssueAnalysis(req.params.id);
  res.json(analysis || { issueId: req.params.id, status: 'none' });
}));

// Analyze ONE issue (synchronous — returns the finished snapshot)
router.post('/issues/:id/editorial/analyze', asyncHandler(async (req, res) => {
  const body = validateRequest(editorialAnalyzeSchema, req.body ?? {});
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await editorialAnalysis.analyzeIssue(req.params.id, body));
}));

// Analyze the whole series (batch — progress via SSE)
router.post('/series/:id/editorial/analyze', asyncHandler(async (req, res) => {
  const body = validateRequest(editorialAnalyzeSchema, req.body ?? {});
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = await editorialRunner.startSeriesAnalysis(req.params.id, body);
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/editorial/analyze/progress`,
  });
}));

router.get('/series/:id/editorial/analyze/progress', (req, res) => {
  const attached = editorialRunner.attachClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active editorial analysis for this series', { status: 404 });
  }
});

// Lightweight probe so a (re)mounting client can re-attach to an in-flight batch.
router.get('/series/:id/editorial/analyze/status', (req, res) => {
  res.json({ active: editorialRunner.isSeriesAnalysisActive(req.params.id) });
});

router.post('/series/:id/editorial/analyze/cancel', asyncHandler(async (req, res) => {
  const canceled = editorialRunner.cancelSeriesAnalysis(req.params.id);
  res.json({ canceled });
}));

export default router;
