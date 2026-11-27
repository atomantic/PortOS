/**
 * Zod schemas for video generation routes (`routes/videoGen.js`) and shot-card clip submission (`services/musicVideo/sceneCardRender.js`).
 */

import { z } from 'zod';
import { VIDEO_GEN_MODES } from './generationModes.js';
import { a2vLoraStageStrengthsSchema, isDefaultA2vLoraStages } from './videoLoraStageValidation.js';
import { grokVideoDurationSchema, modelDownloadQuerySchema } from './sharedSchemas.js';
import { HANDHELD_SEED_MAX } from './handheldCamera.js';
import { JSON_BODY_LIMIT_BYTES } from './uploadLimits.js';
import { VERTICAL_RATIO_IDS } from './verticalReframe.js';
import {
  REACTOR_MAX_CLIP_ID_LENGTH, REACTOR_MIN_CLIP_SECONDS, REACTOR_MAX_CLIP_SECONDS,
  REACTOR_ASPECTS,
} from './reactorVideoClip.js';
import { MIN_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES } from './videoContinuity.js';
import { I2V_REFERENCE_MODES } from './videoReferenceModes.js';
import {
  MAX_VIDEO_BATCH_SIZE,
  VIDEO_GEN_LOCAL_ONLY_FIELDS,
  MAX_VIDEO_REFERENCE_LABEL_LENGTH,
  PREVIEW_UPLOAD_FIELDS,
  UPSCALE_METHODS, DEFAULT_UPSCALE_METHOD,
  FAL_SEEDVR2_TARGET_RESOLUTIONS,
} from './videoGenRequestFields.js';
import { IC_LORA_MODE_VALUES, listIcLoraRemixModes } from './icLoraWeights.js';
import { VIDEO_STREAMING_MODES } from './videoStreamingMode.js';
import { FEDERATED_MEDIA_MAX_VIDEO_FRAMES } from './federatedMediaWire.js';
import { promptAdditionsSchema } from './modelInput.js';
import { VIDEO_TILING_MODES } from './videoTiling.js';
import { RUNWAY_SPECIAL_VIDEO_MODES, RUNWAY_ACT_TWO_RATIOS, RUNWAY_ALEPH_ASPECTS } from './runwaySpecialVideoModels.js';
import { HIGGSFIELD_VIDEO_MODEL_IDS } from './higgsfieldVideoModels.js';
import { GOOGLE_VIDEO_MODEL_IDS } from './googleVideoModels.js';

// Multipart bodies arrive as strings; coerce numerics in the schema. The
// service layer also coerces, but validating at the route boundary catches
// out-of-range / wrong-type input before any work happens.
//
// `optional()` lives INSIDE the preprocess wrapper so that the inner schema
// (`z.number()`) actually receives `undefined` rather than failing with
// "received undefined". With the optional() on the outside the empty-string
// branch was unreachable — preprocess returned undefined and z.number()
// rejected it before optional() ever saw the result.
const optionalNum = (min, max, label) => z.preprocess(
  (v) => v == null || v === '' ? undefined : Number(v),
  z.number().refine((n) => n >= min && n <= max, `${label} ${min}..${max}`).optional(),
);
// numFrames and chunks must be integers. Multipart bodies send `'121'` as
// a string and `'121.5'` would silently coerce to 121.5 — feed that into
// keyframe-index range checks and the maximum becomes a fractional bound,
// not an integer one. Reject up front.
const optionalInt = (min, max, label) => z.preprocess(
  (v) => v == null || v === '' ? undefined : Number(v),
  z.number().int().refine((n) => n >= min && n <= max, `${label} ${min}..${max}`).optional(),
);
// Coarse upper bound for any IC reference array, derived from the registry so a
// weight raising its own maxReferences doesn't get rejected by a stale literal in
// the schema before the per-mode assertion below can speak. Per-weight bounds are
// still enforced against the mode's own spec (assertIcReferenceCount).
const MAX_IC_REFERENCES = Math.max(...listIcLoraRemixModes().map((s) => s.maxReferences));

const MAX_REFERENCE_IMAGE_FILES = 64;
const MAX_REFERENCE_CLIP_IDS = 8;

// Chain ceiling — 8 × ~5min ≈ 40min on an M3 Max keeps the worst-case wall time
// bounded. Shared by `chunks` and the per-chunk prompt list so the two can never
// drift apart.
const MAX_VIDEO_CHUNKS = 8;

// Coerce a multipart/JSON list field to an array. Multipart sends a SINGLE value
// as a bare string and repeated keys as an array; a JSON client may send an
// encoded list, and a client that must preserve blank entries' POSITIONS (see
// `chunkPrompts`) has to. Shared by every list field below so the coercion rule
// can't drift between them.
const listPreprocess = (v) => {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') return v;
  if (v.trim().startsWith('[')) { try { return JSON.parse(v); } catch { return [v]; } }
  return [v];
};

// Render controls that only the local runtimes understand. Keep their schemas
// together so Grok eligibility and request validation cannot drift when a new
// local-only knob is added.
export const LOCAL_ONLY_VIDEO_PARAMS = Object.freeze({
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.NUM_FRAMES]: optionalInt(1, FEDERATED_MEDIA_MAX_VIDEO_FRAMES, 'numFrames'),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.FPS]: optionalNum(1, 60, 'fps'),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.STEPS]: optionalNum(1, 200, 'steps'),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.GUIDANCE_SCALE]: optionalNum(0, 30, 'guidanceScale'),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.BATCH_SIZE]: optionalInt(1, MAX_VIDEO_BATCH_SIZE, 'batchSize'),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.SEED]: optionalNum(0, Number.MAX_SAFE_INTEGER, 'seed'),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.IMAGE_STRENGTH]: optionalNum(0, 1, 'imageStrength'),
  // What the conditioning image PROMISES (#4874) — 'anchor' (default) pins it as
  // frame one, 'inspire' conditions loosely for subject/style. Local-only by
  // construction: grok's image_to_video always anchors, so a request that names a
  // mode is not grok-deliverable and must stay on the local lane rather than be
  // rerouted into a render that silently ignores it. Preprocessed like the numeric
  // knobs because a multipart body sends an unset select as ''.
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.I2V_REFERENCE_MODE]: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.enum(I2V_REFERENCE_MODES).optional(),
  ),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.A2V_LORA_STAGE_STRENGTHS]: z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  }, a2vLoraStageStrengthsSchema.optional().transform((v) => isDefaultA2vLoraStages(v) ? undefined : v)),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.TILING]: z.enum(VIDEO_TILING_MODES).optional(),
  // Which prompt conditioner reads the prompt (lib/videoTextEncoders.js).
  // Validated loosely here and resolved against the MODEL's own option list in
  // the service — the set is per-runtime, so a route-level enum would either
  // have to enumerate every runtime's options or reject a legitimate one.
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.TEXT_ENCODER_ID]: z.string().min(1).max(64).optional(),
  // Named sampler schedule to render with (lib/videoSpeedProfiles.js). Loosely
  // validated here for the same reason as textEncoderId — the option list is
  // per-MODEL. Legacy LTX profiles retain their disclosed fallback. H3's typed
  // adapter/schedule contract refuses incompatible requests before admission.
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.SPEED_PROFILE_ID]: z.string().min(1).max(64).optional(),
  // Block-streaming request for LTX-2/2.5 MLX renders (#6499).
  // scripts/ml/generate_ltx2.py#resolve_streaming_policy() refuses an explicit
  // 'stream' request before loading weights when the mode's pinned pipeline
  // has no streaming parameter (Extend), so this stays a validated pass-
  // through rather than a route-level 400 — the bridge, which can inspect
  // the live pin, owns accept/refuse. Absence and 'auto' are the same
  // request (the bridge's own default).
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.STREAMING_MODE]: z.enum(VIDEO_STREAMING_MODES).optional(),
  [VIDEO_GEN_LOCAL_ONLY_FIELDS.CONTINUITY_STRATEGY]: z.enum(['frame', 'window']).optional(),
});

// Short caption for one `referenceImageN` upload (what the image shows).
const referenceLabel = z.string().max(MAX_VIDEO_REFERENCE_LABEL_LENGTH).optional();

// Browsers send every line break in a multipart text field as CRLF (the HTML form
// encoding rule), so undo that before a prompt is measured, compared or sent to a model.
const lfLineBreaks = (value) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value);
const jsonField = (v) => {
  if (v == null || v === '') return undefined;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
};

export const generateBodySchema = z.object({
  // Optional run window for the queued job (mediaJobQueue/jobSchedule.js).
  schedule: z.preprocess(jsonField, z.object({
    startAt: z.string().datetime().optional(),
    stopBy: z.string().datetime().optional(),
  }).optional()),
  referenceLabel1: referenceLabel,
  referenceLabel2: referenceLabel,
  referenceLabel3: referenceLabel,
  promptAdditions: promptAdditionsSchema,
  // Render backend: the local runtimes (default), the Grok Build CLI's
  // image-first image_to_video flow (#2859 phase 2), fal.ai's queue REST API
  // (#6213), or reactor.inc's fast-h3 API (#6214). Grok, fal, and reactor all
  // ignore the local-only knobs below; they read prompt/negativePrompt,
  // width/height (mapped to an aspect ratio), sourceImageFile/sourceImage,
  // and their own duration field.
  backend: z.enum(VIDEO_GEN_MODES).optional(),
  // Grok image_to_video clip length in seconds — the shared schema (see
  // lib/grokVideoClip.js for which lengths grok actually delivers). Multipart
  // bodies arrive as strings, so coerce first.
  grokDuration: z.preprocess(
    (v) => (v == null || v === '' ? undefined : Number(v)),
    grokVideoDurationSchema.optional(),
  ),
  // fal.ai model id (e.g. 'fal-ai/minimax/hailuo-02/standard/text-to-video')
  // and clip duration in seconds — loosely validated since fal's own model
  // catalog, not PortOS, owns the set of valid ids/durations per model.
  falModelId: z.string().min(1).max(200).optional(),
  falDuration: z.preprocess(
    (v) => (v == null || v === '' ? undefined : Number(v)),
    optionalNum(1, 60, 'falDuration'),
  ),
  // Output resolution for a curated fal model (lib/falVideoModels.js). Loosely
  // validated: the alphabet is per model ('768P' vs '720p'), so the provider
  // resolves it against the chosen model and falls back to that model's
  // default rather than 400ing a render over a stale pin.
  falResolution: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(16).optional()),
  // Ask a fal model that can synthesize audio to do so. Off by default: a
  // PortOS clip is silent unless the caller wants provider audio (a Music
  // Video's master song is its only soundtrack).
  falGenerateAudio: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' || v === '' ? undefined : v),
    z.boolean().optional(),
  ),
  // Runway model id and clip length (lib/runwayVideoModels.js). Loosely
  // validated like falModelId: the provider refuses an uncatalogued id and
  // rounds a length up to one the model delivers.
  runwayModelId: z.string().min(1).max(64).optional(),
  runwayTargetAspect: z.enum(RUNWAY_ALEPH_ASPECTS).optional(),
  runwayRatio: z.enum(RUNWAY_ACT_TWO_RATIOS).optional(),
  runwayBodyControl: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean().optional()),
  runwayExpressionIntensity: optionalNum(1, 5, 'runwayExpressionIntensity'),
  runwaySeed: optionalNum(0, 4294967295, 'runwaySeed'),
  runwayDuration: z.preprocess(
    (v) => (v == null || v === '' ? undefined : Number(v)),
    optionalNum(1, 60, 'runwayDuration'),
  ),
  // Output size ('720p', '1080p'); resolved per model, falling back to its default.
  runwayResolution: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(16).optional()),
  // Higgsfield family (lib/higgsfieldVideoModels.js), length, tier, audio and
  // seed. The provider refuses an uncatalogued family and clamps the length.
  higgsfieldModelId: z.enum(HIGGSFIELD_VIDEO_MODEL_IDS).optional(),
  higgsfieldDuration: z.preprocess(
    (v) => (v == null || v === '' ? undefined : Number(v)),
    optionalNum(1, 60, 'higgsfieldDuration'),
  ),
  higgsfieldResolution: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['480p', '720p', '1080p']).optional()),
  higgsfieldGenerateAudio: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' || v === '' ? undefined : v),
    z.boolean().optional(),
  ),
  higgsfieldSeed: optionalNum(0, 2147483647, 'higgsfieldSeed'),
  // Google Veo model (lib/googleVideoModels.js), length, tier, audio and
  // seed. The provider refuses an uncatalogued model and snaps the length.
  googleModelId: z.enum(GOOGLE_VIDEO_MODEL_IDS).optional(),
  googleDuration: z.preprocess(
    (v) => (v == null || v === '' ? undefined : Number(v)),
    optionalNum(1, 60, 'googleDuration'),
  ),
  googleResolution: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['720p', '1080p']).optional()),
  googleGenerateAudio: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' || v === '' ? undefined : v),
    z.boolean().optional(),
  ),
  googleSeed: optionalNum(0, 4294967295, 'googleSeed'),
  // reactor.inc fast-h3 (#6214): the clip id to chain from
  // (continue_from_clip_id — frame-accurate continuation, unlike fal/grok
  // which start a fresh render each time) and clip length in seconds. The
  // bounds come from lib/reactorVideoClip.js rather than a hand-copied 1-60,
  // which accepted lengths the fast-h3 API rejects outright.
  reactorClipId: z.string().min(1).max(REACTOR_MAX_CLIP_ID_LENGTH).optional(),
  reactorSeconds: z.preprocess(
    (v) => (v == null || v === '' ? undefined : Number(v)),
    optionalNum(REACTOR_MIN_CLIP_SECONDS, REACTOR_MAX_CLIP_SECONDS, 'reactorSeconds'),
  ),
  reactorSeed: z.preprocess(
    (v) => (v == null || v === '' ? undefined : Number(v)),
    optionalNum(0, 2 ** 32 - 1, 'reactorSeed'),
  ),
  // fast-h3 session canvas — a `set_canvas` aspect, NOT width/height: every
  // canvas holds a 768px short edge so the aspect is the whole choice. Omitted
  // means "derive it from the starting frame" (the picker's Auto entry), which
  // is what keeps a portrait image off the 1344x768 canvas every render used to
  // open with. Multipart bodies arrive as strings, so the empty-string sentinel
  // has to read as omitted rather than as an invalid enum value.
  reactorAspect: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(REACTOR_ASPECTS).optional(),
  ),
  prompt: z.preprocess(lfLineBreaks, z.string().max(20000)),
  negativePrompt: z.preprocess(lfLineBreaks, z.string().max(8000).optional()),
  modelId: z.string().max(64).optional(),
  width: optionalNum(64, 2048, 'width'),
  height: optionalNum(64, 2048, 'height'),
  ...LOCAL_ONLY_VIDEO_PARAMS,
  audioStartSec: optionalNum(0, 36000, 'audioStartSec'),
  disableAudio: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  // Per-render override of the install-wide display-sleep default
  // (settings.videoGen.displaySleep, opt-in). Absent means "use the install
  // default" — the local-only branch of submitVideoGenJob only forwards this
  // when the client actually sent a choice, so an omitted field can never
  // clobber the settings-level default with a stale false.
  displaySleep: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  sourceImageFile: z.string().max(512).optional(),
  // A storyboard panel used as layout guidance, never the start frame; its
  // `referenceImageFiles` set the look (services/videoGen/storyboardGuidance.js).
  guidanceImageFile: z.string().min(1).max(512).optional(),
  // Gallery-pick filename for the FFLF end-frame. The end-frame can also
  // arrive as a multipart `lastImage` upload (handled below) — when both
  // are present the upload wins, mirroring the sourceImage/sourceImageFile
  // precedence on the start-frame side.
  lastImageFile: z.string().max(512).optional(),
  // UI mode hint — backend only uses it for logging/branching; absence
  // falls back to inferring (sourceImage→i2v, no source→t2v).
  // IC-LoRA remix modes (`ic-control`, …) come from the weight registry so the
  // enum can never drift from what's actually installable.
  mode: z.enum(['text', 'image', 'fflf', 'extend', 'a2v', ...IC_LORA_MODE_VALUES, ...RUNWAY_SPECIAL_VIDEO_MODES]).optional(),
  // Chain N renders end-to-end: each chunk's last frame becomes the next
  // chunk's start frame, then ffmpeg concats them into one clip. 1..8 to
  // keep the worst-case wall time bounded (8 × ~5min ≈ 40min on M3 Max).
  chunks: optionalInt(1, MAX_VIDEO_CHUNKS, 'chunks'),
  // Optional per-chunk prompt beats for a chained render (#3695). Entry i
  // steers chunk i, so a longer shot can progress through an action instead of
  // replaying the same prompt at every seam. A blank entry is an explicit
  // fallback to the main `prompt` — that's why empty strings are accepted
  // rather than filtered here; prepareVideoGenParams normalizes them to null.
  // Rides as a JSON-encoded array (like `keyframes`) so blank middle entries
  // keep their position and a one-element list can't collapse to the bare
  // string multipart sends for a single repeated key — a bare string is still
  // accepted as a one-entry list for hand-rolled/JSON clients.
  chunkPrompts: z.preprocess(listPreprocess, z.array(z.string().max(8000)).max(MAX_VIDEO_CHUNKS).optional()),
  // How many of the prior chunk's frames each subsequent chunk conditions on.
  // A window carries motion across the seam where a single still can't; `0`
  // opts back into last-frame chaining, and absence takes the default. Only
  // meaningful on a runtime with an extend pipeline — elsewhere it's ignored,
  // not rejected for legacy requests. Explicit window admission is enforced
  // separately and never silently falls back. See lib/videoContinuity.js.
  contextFrames: optionalInt(MIN_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES, 'contextFrames'),
  // History id of a prior render to extend natively (ltx2 runtime only —
  // routes through ExtendPipeline.extend_from_video which conditions on
  // the entire source video's latent rather than a single last frame).
  // The legacy chained-i2v path keeps using sourceImageFile.
  extendFromVideoId: z.string().guid().optional(),
  // IC-LoRA remix reference clip picked from render history instead of uploaded
  // (the `icReference` multipart upload wins when both are present, mirroring
  // the sourceImage/sourceImageFile precedence). Control/Colorize take exactly
  // one reference; Ingredients (a later phase) will take 2-8, hence the array.
  icReferenceVideoIds: z.preprocess(listPreprocess, z.array(z.string().guid()).min(1).max(MAX_IC_REFERENCES).optional()),
  // Ingredients-style IC references: 2-8 gallery STILLS, not clips. A separate
  // field from icReference / icReferenceVideoIds on purpose — those are
  // `video/*` and resolve against render history, and overloading them would
  // let a video ride into an image-kind weight (or vice versa) and produce
  // plausible-looking garbage. Gallery-only, exactly like `keyframes`: the
  // route resolves each basename under PATHS.images.
  icReferenceImageFiles: z.preprocess(
    listPreprocess,
    // Ceiling derived from the registry (the largest maxReferences any weight
    // declares), NOT a hardcoded 8 — a second literal here would silently
    // pre-empt the per-mode registry check with a 422 the moment a weight raised
    // its own maximum. This is only a coarse sanity bound; the real per-weight
    // rule is asserted below against the mode's own spec.
    z.array(z.string().min(1).max(512)).min(1).max(MAX_IC_REFERENCES).optional(),
  ),
  // Ordered gallery stills that join the first-frame input as extra references
  // for a reference-to-video model. Gallery-only like `keyframes`; the coarse
  // bound below only stops an absurd payload, and the real per-model ceiling is
  // asserted in prepareVideoGenParams against the model's `maxReferenceImages`.
  referenceImageFiles: z.preprocess(
    listPreprocess,
    z.array(z.string().min(1).max(512)).min(1).max(MAX_REFERENCE_IMAGE_FILES).optional(),
  ),
  // Prior renders used as ordered video references (coarse bound; the model's
  // `maxReferenceVideos` is asserted in prepareVideoGenParams).
  referenceVideoIds: z.preprocess(listPreprocess, z.array(z.string().guid()).min(1).max(MAX_REFERENCE_CLIP_IDS).optional()),
  // Reference-video conditioning strength for the IC-LoRA channel. Distinct
  // from the IC-LoRA's own fusion strength (fixed at 1.0 server-side) and from
  // `icAttentionStrength`, which scales the conditioning ATTENTION.
  icStrength: optionalNum(0, 2, 'icStrength'),
  icAttentionStrength: optionalNum(0, 1, 'icAttentionStrength'),
  // Skip the IC pipeline's 2x upscale + refine — half-resolution output at
  // roughly half the wall time, useful for previewing a control clip's fit.
  icSkipStage2: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  // Multi-keyframe interpolation (ltx2 + mode='fflf'). Each entry pins one
  // gallery image at a specific pixel-frame index. Indices must be strictly
  // ascending and within [0, numFrames-1]. When set, overrides the legacy
  // sourceImageFile/lastImageFile pair. Multipart bodies arrive as a string,
  // so the preprocess parses JSON before zod sees it.
  keyframes: z.preprocess(
    (v) => {
      if (v == null || v === '') return undefined;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    },
    z.array(z.object({
      file: z.string().min(1).max(512),
      index: z.number().int().min(0).max(1023),
    })).min(2).max(8).optional(),
  ),
  // Video LoRAs to fuse for this render (ltx2 runtime only). Sent as the SAME
  // universal contract image renders use — parallel `loraFilenames` +
  // `loraScales` arrays — NOT a bespoke shape. This is what lets a history
  // requeue via getRenderConfigForItem() (which emits exactly these fields)
  // round-trip with no per-page translation. Multipart sends each array as
  // repeated keys; a SINGLE entry arrives as a bare string and scales arrive as
  // strings, so wrap+coerce in preprocess (mirrors server/lib/imageGenValidation.js).
  // `filename` rejects path separators here; the service re-validates with
  // assertSafeLoraFilename before touching disk.
  loraFilenames: z.preprocess(
    (v) => (v == null || v === '') ? undefined : (Array.isArray(v) ? v : [v]),
    z.array(z.string().min(1).max(255).regex(/^[^/\\]+\.safetensors$/i, 'filename must be a bare .safetensors basename')).max(8).optional(),
  ),
  loraScales: z.preprocess(
    (v) => {
      if (v == null || v === '') return undefined;
      const raw = Array.isArray(v) ? v : [v];
      return raw.map((x) => (typeof x === 'string' && x !== '' ? Number(x) : x));
    },
    z.array(z.number().min(0).max(2)).max(8).optional(),
  ),
  // Music Video director-board i2v render (#1760 Phase 1). When present, the
  // mediaJobQueue completion hook (`musicVideoSceneVideoHook`) appends the
  // finished clip's history id to the project scene's takes (#8965) — durably, even
  // if the director board unmounted mid-render (the i2v counterpart to the
  // Phase 1b reference-frame `musicVideo` tag on the image route). The shot
  // prompt rides in `prompt` and the reference frame in `sourceImageFile`, so
  // the tag carries only the destination identity. The video route always sends
  // multipart, so the object arrives as a JSON string — preprocess-parse it
  // before the schema sees it (mirrors `keyframes` above).
  musicVideo: z.preprocess(
    (v) => {
      if (v == null || v === '') return undefined;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    },
    z.object({
      projectId: z.string().min(1).max(200),
      sceneId: z.string().min(1).max(200),
      catalogBasis: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      // Selective section revision (#9011): names the open revision this
      // generation was submitted for. The completion hook rides it along
      // unused; the submit service refuses the kickoff (409 REVISION_CLOSED)
      // when this revision has since closed, and cancel/state matching in
      // revisionGenerationJobs/revisionSectionStates uses it for an exact
      // match instead of the pre-#9011 scene+time heuristic.
      revisionId: z.string().min(1).max(200).optional(),
      // The shot card's Render: `prompt` is exactly what the director sees and
      // sends, so the shot-intent lines and the silent-model rewrite are skipped.
      promptAsTyped: z.boolean().optional(),
      // `prompt` is the director's own text and the server composes the rest as
      // labeled additions (lib/musicVideo/musicVideoShotPrompt.js, #11317); `audioReactive`
      // names an audio-reactive LoRA take, which gets its guard clause.
      compose: z.boolean().optional(),
      audioReactive: z.boolean().optional(),
      // The shot card's Song audio toggle: hand a cutaway its song slice (true) or
      // render it silent (false), whatever the project's generation mode says.
      songAudio: z.boolean().optional(),
      // Refuse if the saved shot no longer matches the mode the board priced.
      expectedShot: z.enum(['cutaway', 'lipsync', 'music']).optional(),
      expectedClipReferenceFiles: z.array(z.string().min(1).max(512)).max(MAX_REFERENCE_IMAGE_FILES).optional(),
      expectedClipReferenceLabels: z.array(z.string().min(1).max(512)).max(MAX_REFERENCE_IMAGE_FILES).optional(),
      // The shot card's Whole sung line: a performance take's song slice covers
      // the full lyric line the shot sits in; its edit points still frame the shot.
      wholeLine: z.boolean().optional(),
      // The shot card's "Start frame for layout only" (Grok): the frame is sent as a
      // scene reference instead of the locked first frame, so its people can take the references' likeness.
      startFrameLayout: z.boolean().optional(),
      // Higgsfield/fal reference models: 'image' renders plain image-to-video from the frame and leaves
      // the clip references out; unset sends the frame as the first reference when the shot has references.
      frameRoute: z.enum(['reference', 'image']).optional(),
      // Names the overnight batch this take was queued in (musicVideo/overnightRenders.js).
      batchId: z.string().uuid().optional(),
      // The shot card's Render draft / Render final (#16136); the take records it.
      tier: z.enum(['draft', 'final']).optional(),
    }).optional(),
  ),
  // File the clip into this music video's media collection even when no shot
  // keeps it (musicVideoCollectionHook). Collection only; the render is unchanged.
  musicVideoProjectId: z.string().min(1).max(200).optional(),
  // File the finished render into the collection with this name, creating it
  // when absent (requestedCollectionHook; inline for the synchronous image lane).
  collectionName: z.string().trim().min(1).max(80).optional(),
  // FableLoom scene-video render. The media-job completion hook files the
  // finished history id onto the tagged loom node, even if the editor has
  // unmounted. Video requests are multipart, so parse the JSON tag before
  // validation; the tag carries destination identity only.
  fableLoom: z.preprocess(
    (v) => {
      if (v == null || v === '') return undefined;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    },
    z.object({
      loomId: z.string().min(1).max(200),
      episodeId: z.string().min(1).max(200),
      nodeId: z.string().min(1).max(200),
      role: z.enum(['entry', 'hold', 'exit']).optional(),
      transitionId: z.string().min(1).max(200).optional(),
    }).optional(),
  ),
  // Federated media provider (#4348). When set, the render is submitted to
  // THIS registered peer instead of local hardware. Server-validated against
  // the per-peer allowlist, so naming a peer here cannot route work to one the
  // local user never opted into. `mediaProviderEngine` names the provider-side
  // engine inside that allowlist (local generation registers as 'local').
  // What may cross to a peer, and what may not:
  // docs/decisions/2026-08-20-federated-visual-prompts.md
  mediaProviderPeerId: z.string().guid().optional(),
  mediaProviderEngine: z.string().trim().min(1).max(80).optional(),
}).refine((body) => body.prompt.length > 0 || RUNWAY_SPECIAL_VIDEO_MODES.includes(body.mode), {
  message: 'A prompt is required for this workflow.', path: ['prompt'],
});

// The Video Gen form's preview (#11317): the generate body as the form would
// post it, with each upload it holds named instead of attached.
export const promptPreviewBodySchema = generateBodySchema.safeExtend({
  previewUploads: z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.enum(PREVIEW_UPLOAD_FIELDS)).max(PREVIEW_UPLOAD_FIELDS.length)).optional(),
});

// GET /status: `fresh=true` drops the 30s interpreter-health memo before probing (manual Refresh, install completion).
export const statusQuerySchema = z.object({ fresh: z.enum(['true', 'false']).optional() });

export const overnightBodySchema = z.object({
  projectId: z.string().min(1).max(200),
  sceneIds: z.array(z.string().min(1).max(200)).min(1).max(200),
  modelIds: z.array(z.string().min(1).max(256)).min(1).max(4),
  startAt: z.string().datetime().optional(),
  stopBy: z.string().datetime().optional(),
}).refine((b) => !b.startAt || !b.stopBy || Date.parse(b.stopBy) > Date.parse(b.startAt),
  { message: 'The stop-by time must be after the start time', path: ['stopBy'] });

export const overnightQuerySchema = z.object({ projectId: z.string().min(1).max(200) });

export const batchIdParamsSchema = z.object({ batchId: z.string().uuid() });

export const updatePromptSchema = z.object({ prompt: z.string().max(8000) });

// `hidden` is required: reading an absent body as `false` turned a malformed
// request into a silent unhide.
export const visibilitySchema = z.object({ hidden: z.boolean() });

// Legacy base64 callers retain the JSON transport bounds; multipart files bypass them.
export const uploadVideoSchema = z.object({
  data: z.string().min(1).max(JSON_BODY_LIMIT_BYTES),
  filename: z.string().max(255).optional(),
});

export const posterSchema = z.object({ atSec: z.number().finite().nullable() });

// Render jobs use UUID history ids, while shared-gallery uploads use an
// `upload-<uuid8>` id. These operations derive a NEW artifact path from the
// resolved record (an anchor frame, an upscale, a stitch output) rather than
// merely reading or mutating the row, so they hold the tighter of the two
// contracts and accept only the two id forms this install can mint.
export const historyIdSchema = z.string().regex(
  /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|upload-[a-f0-9]{8})$/i,
  'invalid history id',
);

// The method choice, shared by the action's body and the plan endpoint's query
// so the two can never disagree on what is accepted or what an omission means.
// An absent method is exactly Lanczos, so every pre-#6509 client keeps its
// current behavior without sending anything new.
export const upscaleMethodSchema = z.object({
  method: z.enum(UPSCALE_METHODS).default(DEFAULT_UPSCALE_METHOD),
  targetResolution: z.enum(FAL_SEEDVR2_TARGET_RESOLUTIONS).optional(),
  musicVideoProjectId: z.string().min(1).max(128).optional(),
  sceneId: z.string().min(1).max(128).optional(),
});

export const trimBodySchema = z.object({
  startSec: z.number().finite().positive().max(3600).optional(),
  endSec: z.number().finite().positive().max(3600).optional(),
}).refine((b) => b.startSec !== undefined || b.endSec !== undefined, { message: 'startSec or endSec is required' })
  .refine((b) => b.startSec === undefined || b.endSec === undefined || b.endSec > b.startSec, { message: 'endSec must be after startSec', path: ['endSec'] });

export const handheldBodySchema = z.object({
  shake: z.number().finite().min(0).max(1),
  steps: z.number().finite().min(0).max(1),
  seed: z.number().int().min(1).max(HANDHELD_SEED_MAX).optional(),
}).strict();

export const verticalBodySchema = z.object({ ratio: z.enum(VERTICAL_RATIO_IDS) }).strict();

export const stitchBodySchema = z.object({
  videoIds: z.array(historyIdSchema).min(2).max(20),
});

export const topazQuoteBodySchema = z.object({ model: z.enum(['proteus', 'starlight']).default('proteus') });

export const topazJobParamsSchema = z.object({ jobId: z.string().uuid() });

export const topazTokenBodySchema = z.object({ token: z.string().uuid() });

export const speedProfileDownloadQuerySchema = modelDownloadQuerySchema.extend({
  speedProfileId: z.string().min(1).max(64).optional(),
});
