/**
 * Zod schemas for the PATCH /api/settings slices: media generation, render defaults, local LLM, auto-update, series autopilot and music.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import {
  AUTO_UPDATE_CHANNELS, AUTO_UPDATE_MIN_INTERVAL_HOURS_MIN, AUTO_UPDATE_MIN_INTERVAL_HOURS_MAX,
  cloudModelIdString, GOOGLE_CREDENTIAL_MAX_LENGTH
} from './sharedSchemas.js';
import { isValidCronExpression } from './cronValidation.js';
import { providerRefSchema, emptyToUndefined, emptyToNull } from './zodCompat.js';
import { EFFORT_LEVELS } from './provider/providerModels.js';
import { RENDER_TARGET_BACKEND_AUTO, RENDER_TARGETS } from './renderTargets.js';
import { VIDEO_GEN_MODES, QUEUEABLE_IMAGE_MODES, IMAGE_GEN_MODES } from './generationModes.js';
import { GOOGLE_PROJECT_ID_PATTERN, GOOGLE_LOCATION_PATTERN } from './googleCloudConfig.js';
import { isHeaderSafeKey, headerSafeKeyMessage } from './headerSafeKey.js';
import { RUNWAY_IMAGE_MODEL_IDS, RUNWAY_IMAGE_RESOLUTIONS } from './runwayImageModels.js';
import { FAL_IMAGE_MODEL_IDS } from './falImageModels.js';
import { HIGGSFIELD_IMAGE_MODEL_IDS } from './higgsfieldImageModels.js';
import { GOOGLE_IMAGE_MODEL_IDS } from './googleImageModels.js';
import { MAX_IMAGE_EDGE } from './imageLimits.js';
import { pipelineEditorialChecksSettingsSchema } from './pipelineValidation.js';
import { POLLUTING_KEYS } from './objects.js';

// Automatic PortOS self-update (Update tab). Stored under the top-level
// `autoUpdate` key and OFF by default — an install must never start restarting
// itself merely because it upgraded into this code. The accepted interpretation
// of a sparse slice (omitted channel, omitted interval) is `sharedSchemas.js`'s
// `resolveAutoUpdateConfig`, which the scheduler and the settings GET both read
// through, so this boundary schema cannot drift away from it.
export const autoUpdateSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  channel: z.enum(AUTO_UPDATE_CHANNELS).optional(),
  // Hours to wait after the last update before looking for an idle window.
  minIntervalHours: z.number().min(AUTO_UPDATE_MIN_INTERVAL_HOURS_MIN).max(AUTO_UPDATE_MIN_INTERVAL_HOURS_MAX).optional(),
  // Whether a checkout no script may safely repair queues a CoS agent.
  resolveBlockersWithAgent: z.boolean().optional(),
}).strict();

// Scheduled Series Autopilot (#2174). Machine-local per-series cron schedules
// that fire `startSeriesAutopilot` unattended — the AI Provider Usage Policy's
// sanctioned "scheduled automation" exception. Stored under the top-level
// `seriesAutopilot` settings key (NOT on the federated series record — a
// schedule that synced to a peer would double-run the same series). Each entry
// is OFF by default (`enabled` defaults false); the run itself still passes
// through the cos-domain autonomy gate + daily budget inside startSeriesAutopilot.
// provider/model are OPTIONAL overrides — when absent the run uses the series'
// own `series.llm` (or the active provider); the scheduler maps them to the
// pipeline's providerOverride/modelOverride. A blank provider/model (UI sentinel
// for "use the series default") is coerced to undefined so it doesn't pin an
// empty string. Other autopilot run options are intentionally NOT accepted here:
// there's no UI producing them, so a scheduled run uses the series' persisted
// defaults for those (add a field only when a control exists to set it).
// Cron syntax/range validation lives in the pure leaf `cronValidation.js` so the
// scheduler, every save boundary, and the browser cron editor share ONE
// implementation (#6634). Rejects a 5-token-but-out-of-
// range cron like `99 99 * * *` at the PUT boundary (a 400 the UI surfaces)
// instead of letting it be saved+enabled and then silently dropped by
// activeSchedules — which would leave the user with an "enabled" schedule that
// never fires (#2174).
const seriesAutopilotScheduleSchema = z.object({
  seriesId: z.string().min(1).max(64),
  enabled: z.boolean().optional().default(false),
  cron: z.string().min(1).max(120).refine(isValidCronExpression, 'invalid cron expression'),
  timezone: z.string().min(1).max(64).optional(),
  provider: z.preprocess((v) => (v === '' ? undefined : v), providerRefSchema.optional()),
  model: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(200).optional()),
  // Optional per-schedule reasoning effort (#3641), mapped to the run's
  // `effortOverride`. Validated against the union of accepted levels across
  // effort-capable CLIs; the runner clamps a level the chosen provider doesn't
  // offer and drops it for a provider with no effort control.
  effort: z.preprocess((v) => (v === '' ? undefined : v), z.enum(EFFORT_LEVELS).optional()),
  // Run every stage on the provider/model above, ignoring the per-stage pins
  // from the Prompts page. Absent falls through to the persisted
  // pipelineEditorialChecks setting, then off.
  overrideStagePins: z.boolean().optional(),
}).strict();

export const seriesAutopilotSettingsSchema = z.object({
  schedules: z.array(seriesAutopilotScheduleSchema).optional().default([]),
}).strict();

export const featureProviderConfigSchema = z.object({
  providerId: z.preprocess(emptyToUndefined, providerRefSchema.optional()),
  model: z.preprocess(emptyToUndefined, z.string().optional()),
});

// Autofixer settings extend the shared provider assignment with its isolation
// controls. `autoPromote` (default off) is the explicit promotion gate: when
// false the autonomous repair only STAGES a validated patch for review; when
// true a validated (and, if set, verified) diff is applied to the live checkout
// and the process restarted. `verifyCommand` runs in the isolated worktree
// before any change reaches live. See autofixer/sandbox.js.
export const autofixerSettingsSchema = featureProviderConfigSchema.extend({
  autoPromote: z.boolean().optional(),
  verifyCommand: z.preprocess(emptyToUndefined, z.string().max(500).optional()),
});

// Music settings slice (#2911). `chiptune` remembers the Track editor's last
// chiptune generation provider/model pin plus the publish preferences (target
// managed app + subdir inside its repo). `designer` (#4305) is the Generate
// tab's stepped music designer: its provider/model/effort pin plus optional
// meta-prompt overrides for the describe + lyrics steps (a blank override falls
// back to the shipped default server-side, in services/musicDesigner.js).
// Reuses the shared feature-provider shape so an empty-string picker value
// normalizes to unset. Every key stays optional so an older client PUTting only
// `{ chiptune }` — or only `{ designer }` — still validates.
export const musicSettingsSchema = z.object({
  chiptune: featureProviderConfigSchema.extend({
    publishAppId: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
    publishSubdir: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  }).partial().optional(),
  designer: featureProviderConfigSchema.extend({
    effort: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
    describeTemplate: z.preprocess(emptyToUndefined, z.string().max(8000).optional()),
    lyricsTemplate: z.preprocess(emptyToUndefined, z.string().max(8000).optional()),
  }).partial().optional(),
});

// Creative Director settings slice. Each LLM-backed stage can pin its own
// provider/model instead of inheriting the system default. `evaluation` is a
// direct vision API call (blank = auto-pick a local vision model, else fall
// back to the coding agent); treatment and plan run as CoS agent tasks.
// Reuses the shared feature-provider shape so an empty-string picker value
// normalizes to unset.
export const creativeDirectorSettingsSchema = z.object({
  treatment: featureProviderConfigSchema.partial().optional(),
  plan: featureProviderConfigSchema.partial().optional(),
  evaluation: featureProviderConfigSchema.partial().optional(),
});

// Grok Imagegen settings slice (`imageGen.grok`) — the Grok Build CLI backend
// (#2859). No model/effort knobs: grok's image tools run on xAI's fixed image
// backend, so only the enable gate, binary path, default aspect ratio, and
// per-mode cleaner flags are stored. `''` sentinels from the UI preprocess to
// undefined (same convention as other CLI provider slices); aspectRatio is
// constrained to the `N:M` shape the grok tool accepts so a hand-edited
// settings.json can't inject arbitrary prompt text.
export const imageGenGrokSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  grokPath: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(500).optional()),
  aspectRatio: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().regex(/^\d{1,2}:\d{1,2}$/, 'aspect ratio must look like 16:9').optional()),
  parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
});

const agyImageModelSchema = z.preprocess(
  (v) => (v === '' ? undefined : v),
  cloudModelIdString('model must be a valid Agy model id').optional(),
);

// Per-surface render defaults (`settings.renderDefaults`, #3231 Phase 2) —
// one optional entry per render target, each pinning a backend and/or a cloud
// model for that surface. `'auto'`, `''`, and null all mean "no pin — fall
// through to the install default" (renderTargetDefaults normalizes them).
// Deliberately TOLERANT of unknown keys at both levels (no `.strict()`): the
// Settings UI round-trips the WHOLE stored object on every save, so after a
// version rollback (or a newer client against an older server) a target/field
// this build doesn't know would otherwise 400 every Image Gen save until the
// user hand-edits settings.json — the same forward-compat call the settings
// route makes for catalogUserTypes. The route persists the raw body, so a
// newer build's pins survive the round-trip intact rather than being dropped.
// Known fields keep full enum/charset enforcement (that's what stops a bad
// model id reaching a CLI argv); the known-key alphabet is RENDER_TARGETS from
// lib/renderTargets.js, which the client re-exports rather than mirrors.
const renderTargetModelSchema = z.preprocess(
  (v) => (v === '' ? null : v),
  cloudModelIdString('model must be a valid model id').nullable().optional(),
);
// Shared by the per-target entries and `videoGenSettingsSchema.mode` below —
// one copy of the video-backend pin alphabet.
const videoModePinSchema = z.enum([RENDER_TARGET_BACKEND_AUTO, ...VIDEO_GEN_MODES]).nullable().optional();
const renderTargetEntrySchema = z.object({
  imageMode: z.enum([RENDER_TARGET_BACKEND_AUTO, ...QUEUEABLE_IMAGE_MODES]).nullable().optional(),
  imageModel: renderTargetModelSchema,
  videoMode: videoModePinSchema,
  videoModel: renderTargetModelSchema,
});
// A null entry is an explicit "no pin for this surface": the slice PATCH merges
// per target, so clearing one must be sent as a value, not an omitted key.
export const renderDefaultsSettingsSchema = z.object(
  Object.fromEntries(RENDER_TARGETS.map((t) => [t, renderTargetEntrySchema.nullable().optional()])),
);

// '' is stored, not dropped, so a cleared field falls back (the service account's
// project or express mode; the default region) instead of keeping the old value.
const googlePlacementFields = {
  projectId: z.union([z.literal(''), z.string().trim().regex(GOOGLE_PROJECT_ID_PATTERN, 'Not a Google Cloud project id')]).optional(),
  location: z.union([z.literal(''), z.string().trim().regex(GOOGLE_LOCATION_PATTERN, 'Not a Google Cloud region')]).optional(),
};

// Hosted provider key: '' clears. Validated untrimmed, so a pasted trailing
// newline is refused with the setting named rather than silently altered.
// `allowJson` lets Google's service-account JSON (spaces/newlines are legal) through.
const hostedApiKeySchema = (label, max, { allowJson = false } = {}) => z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().max(max).refine(
    (v) => isHeaderSafeKey(v) || (allowJson && v.trim().startsWith('{')),
    { message: headerSafeKeyMessage(label) },
  ).optional(),
);

// Install-wide video render pin (`settings.videoGen`, #3231 Phase 4) — the
// third rung in resolveVideoMode's ladder (request → target pin → THIS →
// local). `'auto'`/`''`/null all mean "no pin — local". Tolerant of unknown
// keys for the same rollback/forward-compat reason as renderDefaults above.
// `defaultModelId` is the install-wide local video model choice used by the
// Video Gen form and pipeline video stages — typed here so a Settings save
// can't write junk to it.
export const videoGenSettingsSchema = z.object({
  mode: videoModePinSchema,
  defaultModelId: z.preprocess(emptyToNull, z.string().trim().max(64).nullable().optional()),
  // Opt-in macOS GPU-watchdog mitigation for local MLX video renders (mlx
  // #3267) — OFF by default, since a render is a short, attended action and
  // sleeping the screen unasked reads as a crash. Set true to have PortOS
  // sleep the display for the duration of a render; also settable per-render
  // (see the `displaySleep` field on POST /api/video-gen).
  displaySleep: z.boolean().optional(),
  grok: z.object({
    parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
  gemini: z.object({
    parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
  // fal.ai queue REST provider (#6213) — settings-stored key wins over the
  // FAL_KEY env var (same precedence as loras.js's Civitai key).
  fal: z.object({
    apiKey: hostedApiKeySchema('fal.ai', 200),
    parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
  // reactor.inc fast-h3 provider (#6214) — same settings-wins-over-env
  // precedence as `fal` above.
  reactor: z.object({
    apiKey: hostedApiKeySchema('reactor.inc', 200),
    parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
  // Runway developer API — same settings-wins-over-env (RUNWAYML_API_SECRET) precedence.
  runway: z.object({
    apiKey: hostedApiKeySchema('Runway', 200),
    parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
  // Higgsfield developer API — KEY_ID:KEY_SECRET; settings win over HIGGSFIELD_API_KEY.
  higgsfield: z.object({
    apiKey: hostedApiKeySchema('Higgsfield', 400),
    parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
  // Google Cloud Agent Platform: the credential is an API key or a service account
  // JSON key (settings win over GOOGLE_CLOUD_API_KEY). Project and region are plain settings.
  google: z.object({
    apiKey: hostedApiKeySchema('Google', GOOGLE_CREDENTIAL_MAX_LENGTH, { allowJson: true }),
    ...googlePlacementFields,
    parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
});

// Runway images share the private video credential; only render settings live here.
export const imageGenRunwaySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.preprocess((v) => v === '' ? undefined : v, z.enum(RUNWAY_IMAGE_MODEL_IDS).optional()),
  resolution: z.enum(RUNWAY_IMAGE_RESOLUTIONS).optional(),
  parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
  // Run the provider delete (Runway asset / fal.ai stored files) once the output is saved locally.
  deleteAfterDownload: z.boolean().optional(),
});

// fal.ai Imagegen settings slice (`imageGen.fal`). The API key is NOT here —
// it is the fal.ai credential the video backend already owns (write-only via
// PUT /api/settings/credentials/fal). `model` must name a catalog endpoint
// (lib/falImageModels.js): each id is a different price, so free text is
// refused rather than persisted and discovered at render time.
export const imageGenFalSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.preprocess((v) => (v === '' ? undefined : v), z.enum(FAL_IMAGE_MODEL_IDS).optional()),
  parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
  deleteAfterDownload: z.boolean().optional(),
});

// Higgsfield Imagegen slice (`imageGen.higgsfield`). The key is the shared
// video credential; `model` must name a catalog endpoint (lib/higgsfieldImageModels.js).
export const imageGenHiggsfieldSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.preprocess((v) => (v === '' ? undefined : v), z.enum(HIGGSFIELD_IMAGE_MODEL_IDS).optional()),
  parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
  deleteAfterDownload: z.boolean().optional(),
});

// Google Imagegen slice (`imageGen.google`). The credential, project and
// region are the shared `videoGen.google` ones; `model` must name a catalog id.
export const imageGenGoogleSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.preprocess((v) => (v === '' ? undefined : v), z.enum(GOOGLE_IMAGE_MODEL_IDS).optional()),
  parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
});

export const imageGenAgySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  agyPath: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(500).optional()),
  model: agyImageModelSchema,
  parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
});

export const imageGenGeminiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
});

// Local backend availability is machine-local configuration. Disabled means
// the user intentionally does not run that backend; it does not remove any
// installed models or prevent an explicit model-management action.
export const localLlmSettingsSchema = z.object({
  ollama: z.object({ disabled: z.boolean().optional() }).strict().optional(),
  lmstudio: z.object({ disabled: z.boolean().optional() }).strict().optional(),
  // Idle windows for the two PM2-managed model servers, in minutes. `0` = never
  // release the model, which is what every install did before this setting
  // existed and stays the default. Capped at a day: a longer window is
  // indistinguishable from "never" and is far likelier a units mix-up.
  llama: z.object({
    idleMinutes: z.number().int().min(0).max(1440).optional(),
    keepLoaded: z.boolean().optional(),
    pinned: z.boolean().optional(),
  }).strict().optional(),
  mtplx: z.object({
    idleMinutes: z.number().int().min(0).max(1440).optional(),
    keepLoaded: z.boolean().optional(),
    pinned: z.boolean().optional(),
    // The launch line a lazy start replays. MTPLX has no Start button any more —
    // the first request that needs it brings it up — so the checkpoint and port
    // the user chose have to outlive the process, or an on-demand start would
    // fall back to "first verified checkpoint in the cache" and quietly serve
    // something they didn't pick.
    launch: z.object({
      model: z.string().trim().max(300).nullable().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    }).strict().optional(),
  }).strict().optional(),
  slotstream: z.object({
    idleMinutes: z.number().int().min(0).max(1440).optional(),
    keepLoaded: z.boolean().optional(),
    pinned: z.boolean().optional(),
    launch: z.object({
      model: z.string().trim().max(300).nullable().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      memoryGb: z.number().min(6).max(512).nullable().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

// Only slices written by patchSettingsSlice callers belong on this mutation
// surface. Credentials/auth and executable-policy parents have dedicated APIs.
const renderFormNumberSchema = z.union([
  z.number().finite(),
  z.string().max(30).refine((value) => value === '' || Number.isFinite(Number(value)), 'Must be numeric or empty'),
]);
const renderFormSettingsSchema = z.object({
  mode: z.enum(IMAGE_GEN_MODES).optional(),
  modelId: z.string().max(300).nullable().optional(),
  cloudModel: z.string().max(300).nullable().optional(),
  width: z.number().int().positive().max(MAX_IMAGE_EDGE).optional(),
  height: z.number().int().positive().max(MAX_IMAGE_EDGE).optional(),
  steps: renderFormNumberSchema.optional(),
  guidance: renderFormNumberSchema.optional(),
  cfgScale: renderFormNumberSchema.optional(),
  quantize: z.enum(['3', '4', '5', '6', '8']).optional(),
  seed: renderFormNumberSchema.optional(),
  negativePrompt: z.string().max(4000).optional(),
  extraStyle: z.string().max(4000).optional(),
}).strict();

export const settingsSlicePartialSchemas = Object.freeze({
  ...Object.fromEntries(Object.entries(localLlmSettingsSchema.shape)
    .map(([runtime, schema]) => [`localLlm.${runtime}`, schema.unwrap()])),
  // The Media settings drawer (ImageGenTab) saves field-by-field through these
  // so a sibling panel's later patch (VideoGen's LocalSetupPanel writing
  // `imageGen.local.pythonPath`) survives a drawer save. Cleared strings travel
  // as '' (every reader falls back on a blank); the two pins that readers
  // coerce with `||` accept null so an un-pin needs no sentinel string.
  imageGen: z.object({
    mode: z.enum(IMAGE_GEN_MODES).optional(),
    // Legacy flat field, kept populated beside `imageGen.external.sdapiUrl`.
    sdapiUrl: z.string().max(500).optional(),
  }).strict(),
  'imageGen.external': z.object({
    sdapiUrl: z.string().max(500).optional(),
    cleanC2PA: z.boolean().optional(),
    denoise: z.boolean().optional(),
  }).strict(),
  'imageGen.local': z.object({
    pythonPath: z.string().max(500).nullable().optional(),
    modelId: z.string().max(300).nullable().optional(),
    cleanC2PA: z.boolean().optional(),
    denoise: z.boolean().optional(),
  }).strict(),
  'imageGen.codex': z.object({
    enabled: z.boolean().optional(),
    codexPath: z.string().max(500).optional(),
    model: z.string().max(300).optional(),
    effort: z.string().max(40).optional(),
    parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    cleanC2PA: z.boolean().optional(),
    denoise: z.boolean().optional(),
  }).strict(),
  'imageGen.grok': imageGenGrokSettingsSchema.strict(),
  'imageGen.agy': imageGenAgySettingsSchema.strict(),
  'imageGen.fal': imageGenFalSettingsSchema.strict(),
  'imageGen.runway': imageGenRunwaySettingsSchema.strict(),
  'imageGen.higgsfield': imageGenHiggsfieldSettingsSchema.strict(),
  'imageGen.google': imageGenGoogleSettingsSchema.strict(),
  'imageGen.gemini': imageGenGeminiSettingsSchema.strict(),
  'imageGen.expose': z.object({ a1111: z.boolean().optional() }).strict(),
  renderDefaults: renderDefaultsSettingsSchema,
  videoGen: videoGenSettingsSchema.pick({
    mode: true, defaultModelId: true, displaySleep: true,
    grok: true, gemini: true, fal: true, runway: true, reactor: true, higgsfield: true, google: true,
  }).partial().strict(),
  'videoGen.grok': z.object({ parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  'videoGen.gemini': z.object({ parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  'videoGen.fal': z.object({ parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  'videoGen.runway': z.object({ parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  'videoGen.higgsfield': z.object({ parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  // The credential is write-only through PUT /api/settings/credentials/google, never this slice.
  'videoGen.google': z.object({ ...googlePlacementFields, parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  'videoGen.reactor': z.object({ parallelLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  pipeline: z.object({ imageGen: renderFormSettingsSchema.nullable().optional() }).strict(),
  writersRoom: z.object({ imageGen: renderFormSettingsSchema.nullable().optional() }).strict(),
  seriesAutopilot: seriesAutopilotSettingsSchema.partial(),
  pipelineEditorialChecks: pipelineEditorialChecksSettingsSchema.partial(),
  autoUpdate: autoUpdateSettingsSchema,
  // The Chiptune panel and the Music Designer each own one sub-slice, so a save
  // from either cannot drop the other's prefs or a template saved elsewhere.
  'music.chiptune': musicSettingsSchema.shape.chiptune.unwrap().strict(),
  'music.designer': musicSettingsSchema.shape.designer.unwrap().strict(),
});

// Check raw JSON before Zod can strip a dangerous key. Arrays can contain
// nested objects too; none may smuggle prototype-related property names.
const hasPollutingKey = (value) => value !== null && typeof value === 'object'
  && Object.entries(value).some(([key, child]) => POLLUTING_KEYS.has(key) || hasPollutingKey(child));

export const settingsSlicePatchSchema = z.preprocess((value, ctx) => {
  if (hasPollutingKey(value)) {
    ctx.addIssue({ code: 'custom', message: 'Prototype-related keys are forbidden' });
  }
  return value;
}, z.object({
  slicePath: z.enum(Object.keys(settingsSlicePartialSchemas)),
  partial: z.record(z.unknown()),
}).strict().superRefine(({ slicePath, partial }, ctx) => {
  const result = settingsSlicePartialSchemas[slicePath].safeParse(partial);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ['partial', ...issue.path] });
    }
  }
}));
