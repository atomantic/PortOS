// Validates pipeline issue, stage, storyboard, render and audio requests.

import { z } from 'zod';
import { PAGE_SIZE_NAMES, DEFAULT_PAGE_SIZE } from './pdfPageSizes.js';
import { MIN_TIMEOUT as STAGE_TIMEOUT_MIN_MS, MAX_TIMEOUT as STAGE_TIMEOUT_MAX_MS } from './aiToolkit/constants.js';
import { EFFORT_LEVELS } from './provider/providerModels.js';
import { SHOT_TYPES, SCREEN_DIRECTIONS } from './shotGrammar.js';
import { imageEdgeSchema, refineImagePixelCap, PIXEL_CAP_MESSAGE } from './sharedSchemas.js';
import {
  LENGTH_PROFILE_NAMES,
  CUSTOM_PAGE_MIN,
  CUSTOM_PAGE_MAX,
  CUSTOM_MINUTE_MIN,
  CUSTOM_MINUTE_MAX,
} from './issueLength.js';
import { ARC_ROLES } from './storyArc.js';
import {
  ISSUE_TITLE_MAX,
  SEASON_ID_MAX,
  ARC_POSITION_MAX,
  IMAGE_PROMPT_CANDIDATE_MAX,
  COMIC_PAGE_VARIANTS,
  SOURCE_KIND,
  STAGE_STATUSES,
  STAGE_INPUT_MAX,
  STAGE_OUTPUT_MAX,
  STAGE_NOTES_MAX,
  AUDIO_CUE_ID_MAX,
  AUDIO_CUE_LABEL_MAX,
  AUDIO_CUE_PROMPT_MAX,
  AUDIO_CUE_ENGINE_MAX,
  AUDIO_FILENAME_MAX,
  AUDIO_MODES,
  AUDIO_CUES_MAX,
  ISSUE_STATUSES,
} from './pipelineIssueConfig.js';
import { ASPECT_RATIOS, QUALITIES } from './creativeDirectorPresets.js';
import { QUEUEABLE_IMAGE_MODES } from './generationModes.js';
import { TEXT_STAGE_IDS } from './pipelineStages.js';

// Print-PDF export options. `size` must name a catalog page size (an unknown one, including an
// Object.prototype key, is a 400); omitted means the default. The `skip` toggles only act on the
// literal value.
export const pipelinePdfQuerySchema = z.object({
  size: z.enum(PAGE_SIZE_NAMES).default(DEFAULT_PAGE_SIZE),
  cover: z.string().optional(),
  backCover: z.string().optional(),
  colophon: z.string().optional(),
});

export const pipelineStageRecoverySchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/) });

// Per-call timeout bounds: STAGE_TIMEOUT_MIN_MS / STAGE_TIMEOUT_MAX_MS are
// imported (aliased) from aiToolkit/constants.js at the top of this file so
// the route validator, the runner (server/services/stageRunner.js), and the
// toolkit's own provider/run validation all share one source of truth. The
// client mirror in client/src/utils/formatters.js can't import across the
// server boundary — comments on both sides flag the requirement to keep
// them in lockstep.

// Accept either a number or a numeric string (UI inputs frequently serialize
// as strings) and validate the resulting integer. `nullable` lets the client
// clear the override explicitly with `null`; absence leaves it untouched.
export const stageConfigUpdateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  // Writer/judge model split (#2167, CWQE Phase 3). A writer stage may pin a
  // DIFFERENT provider/model to grade its own output — `null`/'' clears the pin
  // so the judge falls back to the writer provider (see resolveJudgeForStage).
  // Without these keys the `.strip()` below would silently drop them from the
  // saved config, so schema parity is required in the same change.
  judgeProvider: z.string().nullable().optional(),
  judgeModel: z.string().nullable().optional(),
  // Per-stage reasoning-effort pin (#3641). Optional and opt-in: with no pin the
  // stage inherits a run-level `effortDefault` (Series Autopilot's run effort),
  // then the provider's own config. Validated against the union of every accepted
  // effort value across effort-capable CLIs — the runner clamps a level the chosen
  // provider doesn't offer down its ladder. `null`/'' clears the pin. Without this
  // key the `.strip()` below would silently drop a pin on save.
  effort: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(EFFORT_LEVELS).nullable().optional(),
  ),
  // Multi-candidate draft gate (#2169, CWQE Phase 5). Opt-in, DEFAULT OFF
  // (draftAttempts 1 = single generation, no gate) because each extra attempt
  // multiplies generation + judge cost. When > 1, generateStage re-rolls a fresh
  // draft while the composite qualityScore (#2167) is below draftGateThreshold,
  // up to the attempt cap, and keeps the best-scoring attempt. `null`/'' clears
  // the override. Only judgeable stages (prose/comicScript/teleplay) honor it.
  // Coerce digit-only strings (form inputs) the same way `timeout` does.
  draftAttempts: z.preprocess(
    (v) => {
      if (v === '' || v === null) return null;
      if (v === undefined) return undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
      return v;
    },
    z.number().int().min(1).max(3).nullable().optional(),
  ),
  draftGateThreshold: z.preprocess(
    (v) => {
      if (v === '' || v === null) return null;
      if (v === undefined) return undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
      return v;
    },
    z.number().min(0).max(10).nullable().optional(),
  ),
  timeout: z.preprocess(
    // Treat empty string as a "clear override" (null). Coerce digit-only
    // strings to numbers so form clients that send "900000" still parse —
    // but reject "1e3" / "1.5" / "0x10" by leaving them as the original
    // string so the inner `.number()` check fails. The digit-only rule
    // (and the `.trim()` before it) mirror `parseTimeoutMs` in
    // client/src/utils/formatters.js and `normalizeTimeout` in
    // server/services/stageRunner.js so all three reject the same shapes.
    (v) => {
      if (v === '' || v === null) return null;
      if (v === undefined) return undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (trimmed === '') return null;
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
      }
      return v;
    },
    z.number().int().min(STAGE_TIMEOUT_MIN_MS).max(STAGE_TIMEOUT_MAX_MS).nullable().optional()
  ),
  returnsJson: z.boolean().optional(),
  variables: z.array(z.string()).optional(),
}).strip();
// `.strip()` (Zod default) silently drops unknown keys instead of letting
// them flow into `updateStageConfig`'s `{...existing, ...updatedConfig}`
// spread. Stripping prevents prototype-pollution shapes (`__proto__`,
// `constructor`, `prototype`) and config-key squatting from a client that
// sends an unmodelled field. If a future stage field is added, extend the
// schema rather than reintroducing `.passthrough()`.

// Query params for GET /api/pipeline/series/:id/issues — both are optional;
// when either is present the route returns { items, total, offset, limit }
// instead of the legacy raw array so callers can page large series.
export const issuesListQuerySchema = z.object({
  offset: z.preprocess((v) => (v === undefined ? 0 : Number(v)), z.number().int().min(0)).default(0),
  limit: z.preprocess((v) => (v === undefined ? 1000 : Number(v)), z.number().int().min(1).max(1000)).default(1000),
});

export const issueCreateSchema = z.object({
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX),
  number: z.number().int().min(1).max(9999).optional(),
  // Per-issue length profile — can be set at create time so a user creating
  // a standalone oversized issue (e.g. an annual) doesn't have to open the
  // picker after the fact. Defaults server-side to 'standard'.
  lengthProfile: z.enum(LENGTH_PROFILE_NAMES).optional(),
  pageTarget: z.number().int().min(CUSTOM_PAGE_MIN).max(CUSTOM_PAGE_MAX).nullable().optional(),
  minutesTarget: z.number().int().min(CUSTOM_MINUTE_MIN).max(CUSTOM_MINUTE_MAX).nullable().optional(),
  ephemeral: z.boolean().optional(),
  // Arc pointers — same bounds as issuePatchSchema so the Arc Canvas can
  // create an issue directly inside a season (Zod would otherwise strip them).
  seasonId: z.string().trim().min(1).max(SEASON_ID_MAX).nullable().optional(),
  arcPosition: z.number().int().min(0).max(ARC_POSITION_MAX).nullable().optional(),
  arcRole: z.enum(ARC_ROLES).nullable().optional(),
});

export const titleLogoGenerateSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

export const voiceDiscoverSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// A single storyboard shot within `stages.storyboards.scenes[].shots[]` (#1315).
// Validates the known shot fields and the new film-grammar enums (`shotType`,
// `screenDirection`) — each nullable + tolerant of the UI's "not captured"
// sentinel (null) and an empty-string clear (preprocessed to undefined). It is
// `.passthrough()` (NOT strip) because render-time hooks stamp extra fields onto
// a shot (`startFrameJobId`) that must survive a re-PATCH of the scenes array;
// the load-bearing normalization still happens in `sanitizeShot`
// (sceneExtractor.js) on the auto-extract path, but the route validates the
// enums up front so an invalid framing/direction is rejected, not silently kept.
export const storyboardShotSchema = z.object({
  // id / description are optional here (not at the sanitizer) so the route stays
  // as tolerant as `sanitizeShot`, which synthesizes a missing id and drops a
  // description-less shot — the route's job is only to reject a bad enum, not to
  // tighten the existing client contract.
  id: z.string().trim().max(80).optional(),
  // Bound loosely to the UI's textarea limit (maxLength=4000), NOT the
  // sanitizer's SHOT_DESCRIPTION_MAX (2000). The sanitizer truncates a long
  // description to 2000 downstream; the route must not REJECT one the UI lets a
  // user type (2001–4000) — that would turn the previously-passthrough scenes
  // contract into a 400. The route's job here is only to reject a bad enum.
  description: z.string().max(4000).optional(),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  continuityFromShotId: z.string().trim().max(80).nullable().optional(),
  shotType: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(SHOT_TYPES).nullable().optional(),
  ),
  screenDirection: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(SCREEN_DIRECTIONS).nullable().optional(),
  ),
}).passthrough();

// A storyboard scene as submitted through the visual-stage PATCH. Kept
// `.passthrough()` so the rich, evolving scene shape (heading, slugline,
// dialogue, sceneVideoJobId, …) flows through untouched — only `shots[]` is
// validated (through storyboardShotSchema) so a bad shotType/screenDirection
// is caught at the route instead of persisting unnormalized.
export const storyboardSceneSchema = z.object({
  shots: z.array(storyboardShotSchema).max(64).optional(),
}).passthrough();

// Issue and stage request schemas

const stageInputSchema = z.object({
  status: z.enum(STAGE_STATUSES).optional(),
  input: z.string().max(STAGE_INPUT_MAX).optional(),
  output: z.string().max(STAGE_OUTPUT_MAX).optional(),
  errorMessage: z.string().max(STAGE_NOTES_MAX).optional(),
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
  id: z.string().trim().max(AUDIO_CUE_ID_MAX).optional(),
  label: z.string().max(AUDIO_CUE_LABEL_MAX).nullable().optional(),
  prompt: z.string().max(AUDIO_CUE_PROMPT_MAX).nullable().optional(),
  engine: z.string().trim().max(AUDIO_CUE_ENGINE_MAX).nullable().optional(),
  startSec: z.number().nullable().optional(),
  endSec: z.number().nullable().optional(),
  trackFilename: z.string().trim().max(AUDIO_FILENAME_MAX).nullable().optional(),
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
  audioMode: z.enum(AUDIO_MODES).optional(),
  cues: z.array(audioCueInputSchema).max(AUDIO_CUES_MAX).optional(),
}).strict();

export const issuePatchSchema = z.object({
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX).optional(),
  number: z.number().int().min(1).max(9999).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  // Phase 2 of Story Arc Planning: optional pointer back to a season +
  // ordinal within that season. `null` clears the assignment.
  seasonId: z.string().trim().min(1).max(SEASON_ID_MAX).nullable().optional(),
  arcPosition: z.number().int().min(0).max(ARC_POSITION_MAX).nullable().optional(),
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

export const generateSchema = z.object({
  seedInput: z.string().max(STAGE_INPUT_MAX).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  // Explicit source stages to feed the generation (backport support: generate
  // any stage FROM any other populated stage). Omit for the conventional
  // forward source. The service drops the target itself and empty stages.
  sourceStageIds: z.array(z.enum(TEXT_STAGE_IDS)).optional(),
});

// Path params for the text-stage progress stream. The stage must be a text
// stage — a visual/audio stage has no text-generation channel to attach to.
export const stageProgressParamsSchema = z.object({
  id: z.string().trim().min(1).max(200),
  stageId: z.enum(TEXT_STAGE_IDS),
});

export const visualGenerateSchema = z.object({
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
export const comicPageRenderSchema = z.object({
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
export const comicPageRefineSchema = z.object({
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

export const episodeVideoSchema = z.object({
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  quality: z.enum(QUALITIES).optional(),
  modelId: z.string().trim().max(64).optional(),
  force: z.boolean().optional(),
});

// Single-scene video render. Lighter schema than episodeVideo because there
// is no stitch step — just one t2v render against the scene's existing
// description.
export const sceneVideoSchema = z.object({
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  modelId: z.string().trim().max(64).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  extraStyle: z.string().trim().max(2000).optional(),
});

// Provider/model picker for the LLM-driven panel/scene prompt refine. Both
// are optional — server falls back to the active provider + stage default.
export const promptRefineSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Same picker plus a `count` for the non-destructive N-candidate fan-out
// (issue #904). `count` is clamped server-side to IMAGE_PROMPT_CANDIDATE_MAX,
// but bound it here too so an out-of-range value is a clean 400 rather than a
// silently-clamped surprise.
export const imagePromptsSchema = promptRefineSchema.extend({
  count: z.number().int().min(1).max(IMAGE_PROMPT_CANDIDATE_MAX).optional().default(3),
});

// Source for scene extraction: which text stage to read from (`prose` →
// granular paragraph-grain breakdown via `writers-room-script`; `teleplay`
// → slugline-grain parse via `pipeline-extract-scenes`). `force` overrides
// the "you have N hand-curated scenes already" guard.
// Enum values match `SOURCE_KIND` verbatim so the route forwards `body.from`
// straight through — same string also names the issue's text stage.
export const extractScenesSchema = z.object({
  from: z.enum([SOURCE_KIND.PROSE, SOURCE_KIND.TELEPLAY]).optional().default(SOURCE_KIND.TELEPLAY),
  providerOverride: z.string().trim().max(80).optional(),
  modelOverride: z.string().trim().max(128).optional(),
  force: z.boolean().optional(),
});

export const extractComicPagesSchema = z.object({
  force: z.boolean().optional(),
});

export const extractCanonFromScriptSchema = z.object({
  providerOverride: z.string().trim().max(80).optional(),
  model: z.string().trim().max(128).optional(),
});

export const describeCanonFromProseSchema = z.object({
  providerOverride: z.string().trim().max(80).optional(),
  model: z.string().trim().max(128).optional(),
  // Nouns to backfill — typically the appears-in-this-issue entries that lack
  // a description. The server re-validates each against the universe canon.
  targets: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    kind: z.enum(['character', 'place', 'object']),
  })).min(1).max(500),
});

export const comicPagePatchSchema = z.object({
  rawText: z.string().max(40000),
});

export const autoRunSchema = z.object({
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

export const restoreSchema = z.object({
  runId: z.string().trim().min(1).max(200),
});

// Narration, dialogue, and music request schemas

export const ttsPreviewSchema = z.object({
  voiceId: z.string().trim().min(1).max(200),
  text: z.string().trim().max(500).optional(),
});

export const ttsNarrateSchema = z.object({
  // Do NOT trim: the segment start/end offsets are computed against this exact
  // string and the client slices its original `content` with them, so trimming
  // here would shift every span. narrateProse rejects all-whitespace text.
  text: z.string().min(1).max(12000),
  voiceId: z.string().trim().max(200).optional(),
});

export const ttsNarrateSegmentSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  voiceId: z.string().trim().max(200).optional(),
  expectedSpeech: z.string().trim().max(4000).nullable().optional(),
});

export const ttsNarrateSegmentRescoreSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  heard: z.string().max(4000),
  expectedSpeech: z.string().trim().max(4000).nullable().optional(),
});

export const extractAudioLinesSchema = z.object({ force: z.boolean().optional() });

export const lineEditSchema = z.object({
  text: z.string().max(4000).optional(),
  voiceIdOverride: z.string().trim().max(200).nullable().optional(),
  // Per-line VO start offset (seconds into the stitched episode). null clears
  // the placement so the muxer skips the line. The sanitizer clamps the range.
  offsetSec: z.number().min(0).max(7200).nullable().optional(),
  // Accepted recognizer spelling ("Ay-Ai" for "AI"); null clears it (#10250).
  expectedSpeech: z.string().trim().max(4000).nullable().optional(),
});

export const lineRenderSchema = z.object({ voiceId: z.string().trim().max(200).optional() });

export const musicAttachSchema = z.object({
  trackFilename: z.string().trim().min(1).max(500),
  label: z.string().trim().max(200).nullable().optional(),
});

// Bind to the service registry at the router so validation shares its engine limits.
export function createPipelineMusicSchemas(engines) {
  // Every model id across all engines — the schema validates `modelId` against
  // this union and `generateMusic` resolves it within the chosen engine (falling
  // back to that engine's default for a mismatched id).
  const modelIds = Object.values(engines).flatMap((engine) => engine.models.map((model) => model.id));

  // The widest duration window across engines; per-engine clamping happens in the
  // service, so the schema just rejects absurd values.
  const maxDurationSec = Math.max(...Object.values(engines).map((engine) => engine.maxDurationSec));

  const musicGenerateSchema = z.object({
    prompt: z.string().max(800).refine((value) => value.trim().length > 0, 'prompt is required'),
    engine: z.enum(Object.keys(engines)).optional(),
    durationSec: z.number().min(1).max(maxDurationSec).optional(),
    modelId: z.enum(modelIds).optional(),
  });

  const cuesGenerateSchema = z.object({
    engine: z.enum(Object.keys(engines)).optional(),
    providerOverride: z.string().trim().max(80).optional(),
    modelOverride: z.string().trim().max(128).optional(),
    force: z.boolean().optional(),
  });

  const cueRenderSchema = z.object({
    engine: z.enum(Object.keys(engines)).optional(),
    durationSec: z.number().min(1).max(maxDurationSec).optional(),
    modelId: z.enum(modelIds).optional(),
  });

  return { musicGenerateSchema, cuesGenerateSchema, cueRenderSchema };
}
