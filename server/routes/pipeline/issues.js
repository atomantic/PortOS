/**
 * Pipeline issue routes — Issue/Episode CRUD plus stage operations: text-LLM
 * generation/restore, scene/page/canon extraction, per-page and per-panel
 * renders, prompt refinement, scene/episode video, and the auto-run text
 * chain.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import {
  validateRequest,
  imageEdgeSchema,
  refineImagePixelCap,
  PIXEL_CAP_MESSAGE,
  storyboardSceneSchema,
} from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import { generateStage } from '../../services/pipeline/textStages.js';
import * as autoRunner from '../../services/pipeline/autoRunner.js';
import {
  enqueueVisualImage,
  renderComicPage,
  enqueueStoryboardSceneVideo,
  enqueueStoryboardShotStartFrame,
  refineComicPanelPrompt,
  refineComicPageRender,
  refineStoryboardScenePrompt,
  generateComicPanelImagePrompts,
  generateStoryboardSceneImagePrompts,
} from '../../services/pipeline/visualStages.js';
import { IMAGE_PROMPT_CANDIDATE_MAX } from '../../services/pipeline/refineHelpers.js';
import {
  extractCanonFromProse, summarizeCanonExtraction,
  describeCanonFromProse, summarizeDescribeGaps,
} from '../../services/universeCanon.js';
import { getSeriesCanon } from '../../services/pipeline/seriesCanon.js';
import { startEpisodeVideoForIssue } from '../../services/pipeline/episodeVideo.js';
import { COMIC_PAGE_VARIANTS } from '../../services/pipeline/owners.js';
import { ASPECT_RATIOS, QUALITIES } from '../../lib/creativeDirectorPresets.js';
import { QUEUEABLE_IMAGE_MODES } from '../../services/imageGen/modes.js';
import { extractScenes, scenesFromBeatSheet, SOURCE_KIND } from '../../lib/sceneExtractor.js';
import { resolveSeriesLlmOverride } from '../../lib/seriesLlmOverride.js';
import { parseComicScript } from '../../lib/comicScriptParser.js';
import {
  LENGTH_PROFILE_NAMES,
  CUSTOM_PAGE_MIN, CUSTOM_PAGE_MAX, CUSTOM_MINUTE_MIN, CUSTOM_MINUTE_MAX,
} from '../../lib/issueLength.js';
import { ARC_ROLES } from '../../lib/storyArc.js';
import { mapServiceError, countExtractedCanon } from './shared.js';

const router = Router();

// ---- Issue schemas ----

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
  // Scenes stay passthrough (the rich scene shape evolves freely), but each
  // scene's shots[] is validated through storyboardSceneSchema so a bad
  // shotType/screenDirection enum is rejected at the route (#1315) instead of
  // persisting unnormalized. Non-storyboard visual stages simply carry no shots.
  scenes: z.array(storyboardSceneSchema).max(200).optional(),
  cdProjectId: z.string().trim().max(64).nullable().optional(),
  videoPath: z.string().trim().max(1000).nullable().optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).nullable().optional(),
  quality: z.enum(QUALITIES).nullable().optional(),
  // Per-stage gen config — image mode + optional pinned model + optional
  // refine-LLM override. Sanitizer drops the field entirely when nothing
  // is set, so a `null` here clears it.
  genConfig: z.object({
    imageMode: z.enum(['auto', ...QUEUEABLE_IMAGE_MODES]).optional(),
    imageModelId: z.string().trim().max(200).nullable().optional(),
    refineProvider: z.string().trim().max(200).nullable().optional(),
    refineModel: z.string().trim().max(200).nullable().optional(),
    applyCharacterLoras: z.boolean().optional(),
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
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
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
  // Per-render opt-out for trained character-LoRA auto-apply (local mode).
  applyCharacterLoras: z.boolean().optional().default(true),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

// Full-comic-page render: same knobs as panel render minus `description` /
// `slugline` (the prompt is built server-side from the page's panels[] so it
// stays in sync with whatever the script-extractor produced).
const comicPageRenderSchema = z.object({
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  // See covers.js's makeCoverRenderSchema for the proof/final semantics.
  target: z.enum(COMIC_PAGE_VARIANTS).optional().default('proof'),
  useProofAsBase: z.boolean().optional().default(false),
  // Consistency reference: re-render this page using an adjacent ('prior'/'next')
  // or explicit (0-based index) already-rendered page as a reference image, so a
  // continuing scene keeps incidental/un-described characters + environment
  // consistent. Resolved + bounds-checked in enqueueVisualComicPage.
  //   - omitted / 'auto' → auto-chain off the prior page within the same scene,
  //     render fresh across a scene boundary (the default).
  //   - 'none' → force a fresh render with no reference, even mid-scene.
  //   - 'prior' / 'next' / <index> → explicit reference (errors if unrendered).
  referencePage: z.union([z.enum(['prior', 'next', 'auto', 'none']), z.number().int().min(0)]).optional(),
  // Per-render opt-out for trained character-LoRA auto-apply (local mode).
  applyCharacterLoras: z.boolean().optional().default(true),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

// Per-page "Refine" — a small image-to-image correction to an already-rendered
// page (issue #1534). `instruction` is the user's free-text change; the LLM
// adjusts the page's stored render prompt and the page re-renders i2i from its
// own existing image. The render-tuning fields mirror comicPageRenderSchema,
// minus the compose-from-source-only `useProofAsBase` / `referencePage` /
// `applyCharacterLoras` (a from-self refine has no proof-vs-final base choice
// and no fresh character matching). `target` selects which rendered variant to
// refine; absent → server auto-picks (final when present, else proof).
const comicPageRefineSchema = z.object({
  instruction: z.string().trim().min(1).max(2000),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  target: z.enum(COMIC_PAGE_VARIANTS).optional(),
  // i2i denoise — low preserves the page, just enough to apply the change.
  initImageStrength: z.number().min(0).max(1).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  // No `extraStyle`: the refine renders the LLM-adjusted prompt verbatim and
  // skips composeComicPagePrompt, so a style suffix would be silently dropped.
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
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

// Same picker plus a `count` for the non-destructive N-candidate fan-out
// (issue #904). `count` is clamped server-side to IMAGE_PROMPT_CANDIDATE_MAX,
// but bound it here too so an out-of-range value is a clean 400 rather than a
// silently-clamped surprise.
const imagePromptsSchema = promptRefineSchema.extend({
  count: z.number().int().min(1).max(IMAGE_PROMPT_CANDIDATE_MAX).optional().default(3),
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

const describeCanonFromProseSchema = z.object({
  providerOverride: z.string().trim().max(80).optional(),
  model: z.string().trim().max(128).optional(),
  // Nouns to backfill — typically the appears-in-this-issue entries that lack
  // a description. The server re-validates each against the universe canon.
  targets: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    kind: z.enum(['character', 'place', 'object']),
  })).min(1).max(500),
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

const comicPagePatchSchema = z.object({
  rawText: z.string().max(40000),
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

  const existing = Array.isArray(issue.stages?.storyboards?.scenes) ? issue.stages.storyboards.scenes : [];
  if (existing.length > 0 && !body.force) {
    throw new ServerError(
      `Storyboards already has ${existing.length} scene${existing.length === 1 ? '' : 's'} — pass { force: true } to replace`,
      { status: 409, code: 'PIPELINE_STORYBOARDS_NOT_EMPTY' },
    );
  }

  // Adapt a canonical scene to the pipeline storyboards UI shape: alias
  // `visualPrompt → description` (the textarea binding) and reset the per-scene
  // image-gen job fields. Rich fields (heading/summary/dialogue/...) ride along.
  // Fall back to the scene `summary` when there's no visualPrompt so a scene
  // that only carries the beats clause (the canonical-only case below) still
  // seeds a non-empty description — the refine/image/video paths require one.
  const toStoryboardScene = (s) => ({ ...s, description: s.visualPrompt || s.summary || '', imageJobId: null, prompt: null });

  // The beat sheet's canonical `## Scenes` list (#1552) is the single source of
  // truth for scene numbers + sluglines across every adaptation, so when it
  // exists we use it to ALIGN the storyboards scenes — guaranteeing their
  // numbers/sluglines match the comic pages'. But the list is sparse (no
  // dialogue / visual prompts / shots), and downstream stages need that rich
  // data — audio voice-over is built from `storyboards.scenes[].dialogue`. So
  // we still run the LLM extraction over the source text to get the rich fields,
  // then OVERLAY the canonical numbering/sluglines onto it (hybrid). Only when
  // there's no source text to extract from do we fall back to the canonical list
  // alone (deterministic, no dialogue — but there's nothing to extract it from).
  const canonicalScenes = scenesFromBeatSheet(issue.stages?.idea?.output || '');
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });

  const sourceKind = body.from;
  const source = (issue.stages?.[sourceKind]?.output || '').trim();
  if (!source && canonicalScenes.length === 0) {
    throw new ServerError(
      `Cannot extract scenes — issue's ${sourceKind} stage is empty`,
      { status: 400, code: 'PIPELINE_NO_SOURCE_FOR_SCENE_EXTRACT' },
    );
  }

  let extractedScenes = [];
  let runId = null;
  let providerId = null;
  let model = null;
  if (source) {
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
    const { provider, model: resolvedModel } = resolveSeriesLlmOverride(series, {
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
      modelOverride: resolvedModel,
      tag: `pipeline-storyboards-extract-${sourceKind}`,
    });
    extractedScenes = result.extracted.scenes;
    runId = result.runId;
    providerId = result.providerId;
    model = result.model;
  }

  // Overlay the canonical numbering/sluglines/headings onto the extracted scenes
  // (matched by position) when a canonical list exists — the canonical list wins
  // on identity/ordering while the LLM scene contributes dialogue/visualPrompt/
  // shots/characters. Extracted scenes beyond the canonical count are dropped so
  // the storyboards scene count matches the canonical (and comic-page) scene
  // count; canonical scenes beyond the extracted count carry no dialogue (there
  // was no matching extracted scene), seeding their description from the summary.
  const usedCanonicalList = canonicalScenes.length > 0;
  const finalScenes = usedCanonicalList
    ? canonicalScenes.map((c, i) => {
        // Base on the canonical scene `c` (full sanitized shape with empty
        // dialogue/shots/characters), overlay the LLM scene's rich fields, then
        // re-assert canonical identity (id/heading/slugline) so the canonical
        // numbering always wins. When there's no matching extracted scene
        // (`ext` is {}), the result is just `c` — empty dialogue, summary-seeded
        // description.
        const ext = extractedScenes[i] || {};
        return { ...c, ...ext, id: c.id, heading: c.heading, slugline: c.slugline, summary: ext.summary || c.summary };
      })
    : extractedScenes;

  const storyboardScenes = finalScenes.map(toStoryboardScene);
  const { issue: updatedIssue, stage } = await issuesSvc.updateStage(issue.id, 'storyboards', {
    status: storyboardScenes.length ? 'ready' : 'empty',
    scenes: storyboardScenes,
    lastRunId: runId,
    errorMessage: '',
  });

  res.json({
    issue: updatedIssue,
    stage,
    runId,
    providerId,
    model,
    sceneCount: storyboardScenes.length,
    // 'beat-sheet' when the response is purely the canonical list (no source to
    // extract from); otherwise the LLM source stage the rich fields came from.
    sourceKind: source ? sourceKind : 'beat-sheet',
    usedCanonicalList,
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

// Backfill descriptions for canon nouns that have none, using ONLY what this
// stage's prose establishes. Distinct from extract-canon: extraction invents +
// flags missing renderable axes (so it never leaves a blank), while this pass
// is strictly prose-grounded — a noun the prose never describes comes back in
// the `descGaps` marker so the Nouns UI can flag the manuscript as thin instead
// of fabricating a description that the prose can't support.
router.post('/issues/:id/stages/:stageId/describe-canon', asyncHandler(async (req, res) => {
  const { id, stageId } = req.params;
  if (!CANON_EXTRACT_STAGES.includes(stageId)) {
    throw new ServerError(
      `Stage "${stageId}" does not support canon description — supported: ${CANON_EXTRACT_STAGES.join(', ')}`,
      { status: 400, code: 'PIPELINE_CANON_DESCRIBE_BAD_STAGE' },
    );
  }
  const body = validateRequest(describeCanonFromProseSchema, req.body ?? {});
  const issue = await issuesSvc.getIssue(id).catch((err) => { throw mapServiceError(err); });
  const rawCorpus = (issue.stages?.[stageId]?.output || '').trim();
  if (!rawCorpus) {
    throw new ServerError(
      `Cannot describe canon — issue's ${stageId} stage is empty`,
      { status: 400, code: 'PIPELINE_CANON_DESCRIBE_NO_CORPUS' },
    );
  }
  const corpus = rawCorpus.length > EXTRACT_CANON_CORPUS_MAX
    ? rawCorpus.slice(0, EXTRACT_CANON_CORPUS_MAX)
    : rawCorpus;
  const series = await seriesSvc.getSeries(issue.seriesId).catch((err) => { throw mapServiceError(err); });
  if (!series.universeId) {
    throw new ServerError(
      `Cannot describe canon — series has no linked universe. Link a universe in the series settings first.`,
      { status: 400, code: 'PIPELINE_CANON_DESCRIBE_NO_UNIVERSE' },
    );
  }
  // Same provider/model resolution as extract-canon so a manual describe honors
  // the series-header LLM (or the per-attempt picker override).
  const { provider, model } = resolveSeriesLlmOverride(series, {
    overrideProvider: body.providerOverride,
    overrideModel: body.model,
  });

  const result = await describeCanonFromProse(series.universeId, {
    corpus,
    targets: body.targets,
    providerOverride: provider,
    modelOverride: model,
  }).catch((err) => { throw mapServiceError(err); });

  const marker = summarizeDescribeGaps({ report: result.report, provider, model });
  const { issue: stampedIssue } = await issuesSvc.updateStage(id, stageId, { descGaps: marker })
    .catch((err) => { throw mapServiceError(err); });

  res.json({
    universe: result.universe,
    issue: stampedIssue,
    descGaps: marker,
    report: result.report,
    sourceStage: stageId,
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
        // Re-derive the scene marker from the edited header so editing
        // `## Page N — Scene M: SLUGLINE` retags the page (and clears it when
        // the marker is removed). `?? null` normalizes the absent case.
        sceneNumber: fresh.sceneNumber ?? null,
        sceneHeading: fresh.sceneHeading ?? null,
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

  // renderComicPage enqueues AND persists the in-flight slot onto
  // pages[pageIndex].{proofImage|finalImage} through the serialized issue write
  // tail (#2241) — the same shared entry point the CDO orchestrator tool calls,
  // so an orchestrated page completes exactly like a user-driven one. The
  // persist runs inside updateStageWithLatest's computeFn so the slot lands on
  // the freshest persisted pages array (a concurrent page edit or sibling
  // render can't be reverted by a stale snapshot).
  const result = await renderComicPage(req.params.id, { pageIndex, ...body })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// AI prompt-refine + image-to-image re-render for a small correction to an
// already-rendered comic page (issue #1534). The service adjusts the page's
// stored render prompt per the user's instruction and re-renders i2i from the
// page's existing image; the new jobId + adjusted prompt land on the matching
// variant slot — same persist path as /render, so a concurrent edit or sibling
// render can't be reverted by a stale snapshot.
router.post('/issues/:id/stages/comicPages/pages/:pageIndex/refine-render', asyncHandler(async (req, res) => {
  const pageIndex = Number(req.params.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ServerError('pageIndex must be a non-negative integer', {
      status: 400, code: 'PIPELINE_COMIC_PAGE_BAD_INDEX',
    });
  }
  const body = validateRequest(comicPageRefineSchema, req.body ?? {});

  // Validate the page exists up front so a bad index skips the bible load + LLM
  // refine entirely (mirrors the /render route's pre-flight). The service also
  // 404s before the LLM call — this just fails faster and more cheaply.
  const issue = await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const pages = Array.isArray(issue.stages?.comicPages?.pages) ? issue.stages.comicPages.pages : [];
  if (!pages[pageIndex]) {
    throw new ServerError(
      `pageIndex ${pageIndex} out of range — comicPages has ${pages.length} page${pages.length === 1 ? '' : 's'}`,
      { status: 404, code: 'PIPELINE_COMIC_PAGE_NOT_FOUND' },
    );
  }

  // refineComicPageRender adjusts the page's stored render prompt (LLM),
  // re-renders i2i from the page's existing image, AND persists the new slot on
  // the matching variant through the serialized issue write tail (#2241) — same
  // shared code path the CDO orchestrator tool uses. A concurrent edit or
  // sibling render can't be reverted by a stale snapshot.
  const result = await refineComicPageRender(req.params.id, { pageIndex, ...body })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
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

// Non-destructive N-candidate variant: generate `count` alternative image-gen
// prompts for one comic panel without touching the panel description. The
// client lists them and lets the user copy or apply one (issue #904).
router.post('/issues/:id/stages/comicPages/pages/:pageIndex/panels/:panelIndex/image-prompts',
  asyncHandler(async (req, res) => {
    const body = validateRequest(imagePromptsSchema, req.body ?? {});
    const result = await generateComicPanelImagePrompts(
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

// Non-destructive N-candidate variant for a storyboard scene (issue #904).
router.post('/issues/:id/stages/storyboards/scenes/:index/image-prompts',
  asyncHandler(async (req, res) => {
    const body = validateRequest(imagePromptsSchema, req.body ?? {});
    const result = await generateStoryboardSceneImagePrompts(
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

export default router;
