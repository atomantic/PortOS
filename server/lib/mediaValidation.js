/**
 * Media-generation & local-model infrastructure Zod schemas (split out of
 * validation.js, issue #1831).
 *
 * Covers LoRA training config + run params, the local-LLM (Ollama / LM Studio)
 * backend management routes, OpenWorld snapshot config/query, and the media-
 * collection bulk add/remove payloads. validation.js re-exports everything here
 * (flat) so existing deep imports keep working; the barrel surfaces it as the
 * `mediaValidation` namespace.
 */
import { z } from 'zod';
import { PORTS } from './ports.js';
import { ASSESSABLE_RUNTIMES } from './localProviderRuntime.js';
import { SWEEP_SCOPES } from './localModelAssessment.js';
import { CAPABILITY_TEST_IDS } from './modelCapabilityTests.js';
import { HF_REPO_ID_RE } from './huggingfaceLora.js';

// iMessage ingestion config (#2151) — the `settings.imessage` slice. Sync is OFF
// by default and only reads chat.db when enabled (needs macOS Full Disk Access).
// Validated as a settings slice on PUT /api/settings; service-side DEFAULT_CONFIG
// fills any absent field so an install with no `imessage` key still resolves.
export const imessageConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional()
});

// Signal Desktop ingestion config (#2154) — the `settings.signal` slice. Sync is
// OFF by default and only reads Signal's SQLCipher-encrypted chat DB (via the
// keychain-wrapped key) when enabled. Validated as a settings slice on
// PUT /api/settings; service-side DEFAULT_CONFIG fills any absent field so an
// install with no `signal` key still resolves (default cadence 60min).
export const signalConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional()
});

// Spotify listening-history ingestion config (#2152) — the `settings.spotify`
// slice. Sync is OFF by default and only polls the recently-played API when
// enabled AND the user has completed OAuth (credentials/tokens live under
// data/spotify/, not settings). Validated as a settings slice on
// PUT /api/settings; service-side DEFAULT_CONFIG fills any absent field.
export const spotifyConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional()
});

// YouTube watch-history ingestion config (#2153) — the `settings.youtube` slice.
// The scrape is OFF by default and only reads the signed-in history page in the
// managed browser when enabled. Validated as a settings slice on PUT /api/settings;
// service-side DEFAULT_CONFIG fills any absent field (default cadence ~8h, since
// the history page is day-bucketed) so an install with no `youtube` key resolves.
export const youtubeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional()
});

// Shared LoRA-training parameter bounds — used by both the settings-slice
// defaults and the per-run override on POST /api/lora-training/runs.
const loraTrainingParamsSchema = z.object({
  steps: z.number().int().min(10).max(10000).optional(),
  rank: z.number().int().min(1).max(128).optional(),
  learningRate: z.number().positive().max(0.1).optional(),
  resolution: z.union([z.literal(512), z.literal(768), z.literal(1024)]).optional(),
  seed: z.number().int().optional(),
  checkpointEvery: z.number().int().min(0).max(5000).optional(),
  sampleEvery: z.number().int().min(0).max(5000).optional(),
  samplePrompt: z.string().max(2000).optional(),
  // Per-run frozen-base overrides (issue #1321/#1407), mflux runtime only.
  // `baseQuant` picks the quant of the frozen base — 16 = unquantized bf16, 8/4
  // = QLoRA bit-width — letting a run opt into a heavier/lighter base than the
  // memory-derived default without a code change. `lowRam` toggles the on-disk
  // latent-cache spill. `null` is the form's "Auto": a deliberate clear that
  // forces the deriveMfluxMemoryConfig tier even when a saved default exists
  // (distinct from absent, which lets the saved default merge through). An
  // explicit value still cannot exceed the LORA_TRAIN_MAX_QUANT_BITS cap.
  baseQuant: z.union([z.literal(4), z.literal(8), z.literal(16)]).nullable().optional(),
  lowRam: z.boolean().nullable().optional(),
});

// LoRA training settings slice (`settings.loraTraining`) — vision-caption
// provider pick + training parameter defaults. Code-level defaults live in
// `services/loraTraining/runtimes.js` so an absent slice needs no migration.
export const loraTrainingConfigSchema = z.object({
  // Both nullable — the caption-model picker clears them to null on "Auto"
  // (defer to the server's vision-model auto-pick).
  captionProviderId: z.string().max(128).nullable().optional(),
  captionModel: z.string().max(256).nullable().optional(),
  defaults: loraTrainingParamsSchema.optional(),
  // Segmented mflux training (watchdog-panic mitigation, default ON in
  // services/loraTraining/runtimes.js). Setting this false runs the trainer as
  // one sustained process again — flip it once a macOS/mflux update resolves
  // the GPU-driver hang. Cooldown is the GPU idle gap (seconds) between segments.
  segmentation: z.boolean().optional(),
  segmentCooldownSec: z.number().int().min(0).max(3600).optional(),
  // Phase-aware soft-hang stall watchdog (issue #1330, default ON in
  // services/loraTraining/index.js). Detects a wedged GPU mid-training (steps
  // stop arriving within a step-rate-derived budget) and SIGKILLs + auto-resumes
  // from the newest checkpoint. Set false to fall back to only the flat 30-min
  // idle watchdog (e.g. if a future driver fix makes soft hangs impossible).
  stallWatchdog: z.boolean().optional(),
  // Auto display-sleep during training on Apple Silicon (default ON — the
  // `!== false` read lives in services/loraTraining/displayPower.js
  // isDisplaySleepEnabled). Sleeps the Mac's display when a run starts
  // and wakes it when it finishes. This is the validated mitigation for the GPU
  // watchdog kernel panic (mlx #3267): an active display makes WindowServer
  // contend for the GPU, which hard-reboots the box during heavy sustained
  // training. Set false if you drive the display some other way (SSH headless).
  displaySleep: z.boolean().optional(),
});

// POST /api/lora-training/runs — start a training run for a dataset.
export const startTrainingRunSchema = z.object({
  datasetId: z.string().min(1).max(128),
  baseModelId: z.string().min(1).max(128),
  name: z.string().trim().max(120).optional(),
  params: loraTrainingParamsSchema.optional(),
  // Override the caption identity-leak gate (see validateDatasetReady) and train
  // anyway — the UI sends this from the explicit "Train anyway" action.
  acknowledgeCaptionLeak: z.boolean().optional(),
});

// === Local LLM backends (Ollama / LM Studio) ===
export const localLlmBackendSchema = z.enum(['ollama', 'lmstudio']);
// modelId is passed positionally to the `lms` CLI (execFile, no shell) — reject
// a leading dash (would be parsed as a flag) and control chars (NUL / newline).
export const localLlmModelIdSchema = z.string().min(1).max(256)
  .refine((v) => !v.startsWith('-'), { message: 'modelId may not start with "-"' })
  .refine((v) => !/[\0\r\n]/.test(v), { message: 'modelId may not contain control characters (NUL, CR, LF)' });
export const localLlmInstallSchema = z.object({
  backend: localLlmBackendSchema,
  modelId: localLlmModelIdSchema,
  // Re-pull even when the model is already on disk. Needed when a publisher
  // replaces GGUF files in place (e.g. Unsloth Dynamic 3.0) under the same id.
  force: z.boolean().optional(),
});
export const localLlmDeleteSchema = localLlmInstallSchema;
// Memory-management unload: same `backend` + `modelId` shape as install/delete
// so the validator catches the same set of malformed ids (no leading dash,
// no control chars) — those reach Ollama via `/api/generate` body fields and
// then echo into PortOS's emoji-prefixed unload log line.
export const localLlmUnloadSchema = localLlmInstallSchema;
export const localLlmSwitchSchema = z.object({ to: localLlmBackendSchema });
// Migrate moves models from the OTHER backend onto `to` (bidirectional, never
// flips the default marker). `mode` picks how the GGUF lands on disk: 'link'
// hardlinks/shares it (default), 'copy' duplicates it.
export const localLlmMigrateSchema = z.object({
  to: localLlmBackendSchema,
  mode: z.enum(['link', 'copy']).optional().default('link'),
});
export const localLlmInstallBackendSchema = z.object({ backend: localLlmBackendSchema });
export const localLlmOllamaServiceSchema = z.object({ action: z.enum(['start', 'stop', 'enable', 'disable']) });
// LM Studio's own server has no enable/disable equivalent (the app owns its
// launch-at-login), so this is start/stop only — deliberately NOT reusing the
// Ollama schema, which would accept two actions `lms` cannot perform.
export const localLlmLmStudioServiceSchema = z.object({ action: z.enum(['start', 'stop']) });
// MTPLX launch. Every field is optional: with none of them PortOS serves the
// checkpoint already in MTPLX's cache on the port the shipped provider presets
// point at. `model` is a Hugging Face repo id, which lands in the launch argv.
export const localLlmMtplxStartSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).optional(),
  // No `host`: MTPLX is a loopback daemon and the manager never puts one on the
  // launch line, so accepting one would only record an endpoint it isn't bound to.
  model: z.string().trim().max(200).regex(
    /^$|^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/,
    'model must be a Hugging Face repo id',
  ).optional().nullable(),
});
// Slotstream launch. Every field is optional: with none of them PortOS serves
// the first cached checkpoint on the dedicated loopback port. `memoryGb` is the
// explicit cache-size cap persisted on the saved launch line; absent = auto.
export const localLlmSlotstreamStartSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).optional(),
  model: z.string().trim().max(300).optional().nullable(),
  memoryGb: z.coerce.number().min(6).max(512).optional().nullable(),
});
// A checkpoint download. `model` is a curated catalog id (`qwen3-30b-a3b-4bit`)
// or a Hugging Face repo id — the service resolves which, and refuses anything
// that is neither. Unlike a start, this one field is never optional: PortOS has
// no "download whatever" default for a transfer this size.
const slotstreamModelSchema = z.string().trim().min(1).max(200);
export const localLlmSlotstreamDownloadSchema = z.object({ model: slotstreamModelSchema });
// MTPLX model catalog. `mtplx forge discover` is upstream's own index of
// MTPLX-branded MTP checkpoints; an empty query means its default listing.
export const localLlmMtplxSearchSchema = z.object({
  query: z.string().trim().max(200).optional().default(''),
  limit: z.coerce.number().int().min(1).max(100).optional().default(24),
  offset: z.coerce.number().int().min(0).max(10000).optional().default(0),
});
// A checkpoint download. `model` omitted means MTPLX's own verified default —
// the same one the provider-readiness checklist pulls — so the two surfaces
// cannot fetch different weights. A named model must be a Hugging Face repo id.
const mtplxRepoIdSchema = z.string().trim().min(1).max(200).regex(
  HF_REPO_ID_RE,
  'model must be a Hugging Face repo id (owner/name)',
);
export const localLlmMtplxPullSchema = z.object({
  model: mtplxRepoIdSchema.optional().nullable(),
});
// Removal always names a checkpoint — there is no "remove whatever is cached".
export const localLlmMtplxRemoveSchema = z.object({ model: mtplxRepoIdSchema });
export const localLlmLlamaServerStartSchema = z.object({
  model: z.string().trim().min(1).max(500),
  draftModel: z.string().trim().max(500).optional().nullable(),
  // A comma-separated list of llama.cpp `--spec-type` implementations
  // (`ngram-map-k`, `draft-dflash,ngram-map-k`). Free vocabulary on purpose —
  // fork builds ship their own — but shaped, since it lands in the launch argv.
  // Empty is allowed and means "no speculative decoding".
  specType: z.string().trim().max(100).regex(
    /^$|^[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*$/,
    'specType must be a comma-separated list of llama.cpp spec-type names',
  ).optional().default('draft-dflash'),
  port: z.coerce.number().int().min(1).max(65535).optional().default(PORTS.LLAMA_SERVER),
  host: z.string().trim().max(100).optional().default('127.0.0.1'),
  ctxSize: z.coerce.number().int().min(512).max(1048576).optional().default(32768),
  nGpuLayers: z.coerce.number().int().min(0).max(999).optional().default(99),
  alias: z.string().trim().max(100).optional().default('dflash'),
  // PortOS-opinionated, unlike the tuning flags below: llama-server's own
  // default is often 4 slots, which divides `--ctx-size` and spends VRAM on
  // unused batch buffers. A TUI agent is one long session, so 1 is the pin.
  parallel: z.coerce.number().int().min(1).max(16).optional().default(1),
  // Tuning flags. Every one defaults to null = NOT SET, so the flag is left off
  // the launch line and llama.cpp applies its own default — a numeric default
  // here would silently pin a value the user never chose. Ranges mirror
  // `lib/localModelTuning.js`; keep them in lockstep.
  batchSize: z.coerce.number().int().min(1).max(8192).optional().nullable().default(null),
  ubatchSize: z.coerce.number().int().min(1).max(8192).optional().nullable().default(null),
  threads: z.coerce.number().int().min(1).max(256).optional().nullable().default(null),
  flashAttn: z.boolean().optional().default(false),
  cacheTypeK: z.enum(['f16', 'q8_0', 'q4_0']).optional().nullable().default(null),
  cacheTypeV: z.enum(['f16', 'q8_0', 'q4_0']).optional().nullable().default(null),
  draftMax: z.coerce.number().int().min(0).max(64).optional().nullable().default(null),
});
// Speculative-decoding weight download: which curated preset, and which half of
// the pair. Both are enum-ish server-owned ids — no path or repo ever arrives
// from the client, so a request can only ever write to a curated `models/` file.
export const localLlmSpecModelDownloadSchema = z.object({
  presetId: z.string().trim().min(1).max(100),
  role: z.enum(['model', 'draftModel']),
});
// Confirm-step disk preflight for a weight download. Discriminated on `kind`
// so the server resolves dest + expected size — the client never supplies a
// path. `insufficient` is returned as a verdict, not thrown, so the confirm
// UI can disable the button instead of toasting a failure the user hasn't
// committed to yet. The download endpoints still throw DISK_INSUFFICIENT.
export const localLlmDownloadPreflightSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('spec-decode'),
    presetId: z.string().trim().min(1).max(100),
    role: z.enum(['model', 'draftModel']),
  }),
  z.object({
    kind: z.literal('mtplx'),
    model: mtplxRepoIdSchema.optional().nullable(),
  }),
  z.object({
    kind: z.literal('slotstream'),
    model: slotstreamModelSchema,
  }),
  z.object({
    kind: z.literal('install'),
    backend: localLlmBackendSchema,
    modelId: localLlmModelIdSchema,
  }),
]);
export const localLlmHuggingFaceSearchSchema = z.object({
  backend: localLlmBackendSchema,
  q: z.string().max(160).optional().default(''),
  category: z.string().max(40).optional().default('all'),
  limit: z.coerce.number().int().min(1).max(30).optional().default(12),
});
export const localLlmPlaygroundOptionsSchema = z.object({
  systemPrompt: z.string().max(8000).optional().default(''),
  temperature: z.coerce.number().min(0).max(2).optional().default(0.3),
  maxTokens: z.coerce.number().int().min(1).max(8192).optional().default(1000),
  timeoutMs: z.coerce.number().int().min(1000).max(600000).optional().default(300000),
});
export const localLlmTestSchema = localLlmPlaygroundOptionsSchema.extend({
  backend: localLlmBackendSchema,
  modelId: localLlmModelIdSchema,
  prompt: z.string().trim().min(1).max(50000),
});
// Assessments reach EVERY local runtime PortOS can talk to, not just the two it
// installs models for — llama.cpp, MTPLX, and vLLM are bare OpenAI-compatible
// daemons with no PortOS-side catalog. `localLlmBackendSchema` stays narrow
// because install/delete/migrate genuinely only work on the managed pair.
export const localLlmRuntimeSchema = z.enum(ASSESSABLE_RUNTIMES);
// Tuning knobs are validated for SHAPE only (a flat map of scalars). Which keys
// a runtime accepts, and their ranges, live in `lib/localModelTuning.js` — one
// catalog, applied by `normalizeTuning`, rather than a Zod copy that would drift
// from it. Unknown keys are dropped there, so a bogus key cannot reach a launch
// line.
export const localLlmTuningSchema = z.record(
  z.string().max(64),
  z.union([z.number(), z.boolean(), z.string().max(64)])
).optional();
// Measured local-model assessment (server/services/localModelAssessments.js). One
// request runs ONE model across up to 5 nominal context sizes; the cap keeps a
// single user click from turning into an unbounded, minutes-long provider job.
// 131072 is the largest context any shipped local model advertises.
export const localLlmAssessmentRunSchema = z.object({
  backend: localLlmRuntimeSchema,
  modelId: localLlmModelIdSchema,
  contextTokens: z.array(z.coerce.number().int().min(64).max(131072)).min(1).max(5).optional(),
  tuning: localLlmTuningSchema,
});
// "Measure everything" — one request, one server-side queue, hours of provider
// work. The scope decides WHICH models (see `selectSweepTargets`); the target
// list itself is derived server-side rather than sent, so a client can't ask for
// an arbitrary batch of models.
// A TUNING sweep names one model and sets `tunings: true`; the grid itself is
// derived server-side (`tuningGridFor`) rather than sent, for the same reason
// the model list is — a client must not be able to ask for an arbitrary batch of
// provider calls. There is deliberately no wire knob for the grid SIZE either:
// the consent gate names its count from the report's grid, so a request that
// could shrink the grid would run a different number than the one the user
// agreed to.
export const localLlmAssessmentSweepSchema = z.object({
  scope: z.enum(SWEEP_SCOPES).optional().default('unmeasured'),
  contextTokens: z.array(z.coerce.number().int().min(64).max(131072)).min(1).max(5).optional(),
  backend: localLlmRuntimeSchema.optional(),
  modelId: localLlmModelIdSchema.optional(),
  tunings: z.boolean().optional().default(false),
}).refine((v) => Boolean(v.backend) === Boolean(v.modelId), {
  // Half a model reference would silently fall back to the scope and measure
  // every installed model — hours of work nobody asked for.
  message: 'backend and modelId must be given together',
  path: ['modelId'],
});
export const localLlmAssessmentIntentSchema = z.object({
  intent: z.enum(['balanced', 'smartest', 'fastest', 'lightweight']).optional().default('balanced'),
});
// One explicit local-TUI task through each configured Qwen runtime preset. The
// service still restricts the model id and provider to the named target for that
// backend, so this endpoint cannot become an arbitrary CLI launcher.
export const localLlmAgentBenchmarkSchema = z.object({
  backend: z.enum(['ollama', 'ollama-coder', 'mtplx', 'llama', 'claude-ollama']),
  modelId: localLlmModelIdSchema,
  timeoutMs: z.coerce.number().int().min(10000).max(600000).optional().default(600000),
});
// `tuningKey` identifies WHICH measurement of a model to drop — several can now
// coexist, one per tuning. Absent/'' targets the backend-defaults record, which
// is exactly what a pre-tuning client sends.
export const localLlmAssessmentDeleteSchema = z.object({
  backend: localLlmRuntimeSchema,
  modelId: localLlmModelIdSchema,
  tuningKey: z.string().max(500).optional().default(''),
});

// Capability tests (server/services/modelCapabilityTests.js). One request runs
// ONE test against ONE model — deliberately not a batch. A capability run is a
// manual act with a consent gate in front of it, and an endpoint that could
// accept a list of models would turn one click into an unbounded, hours-long
// sequence of provider calls the gate never named.
//
// `testId` is validated against the shipped catalog rather than as free text:
// the id selects which runner executes, so an unknown one must be a 400 at the
// edge, not a lookup miss deep in the service.
export const localLlmCapabilityTestSchema = z.object({
  backend: localLlmRuntimeSchema,
  modelId: localLlmModelIdSchema,
  testId: z.enum(CAPABILITY_TEST_IDS),
});
// Run, read-one and delete all name exactly one model+test pairing, so they
// share a schema rather than three copies that could drift apart.
export const localLlmCapabilityTestRunSchema = localLlmCapabilityTestSchema;
export const localLlmCapabilityTestDeleteSchema = localLlmCapabilityTestSchema;

export const localLlmCompareSchema = z.object({
  mode: z.enum(['round-robin', 'parallel']).optional().default('round-robin'),
  prompt: z.string().trim().min(1).max(50000),
  targets: z.array(z.object({
    backend: localLlmBackendSchema,
    modelId: localLlmModelIdSchema,
  })).min(1).max(6),
  options: localLlmPlaygroundOptionsSchema.optional().default({}),
});

// =============================================================================
// MEDIA COLLECTIONS — bulk add/remove items
// =============================================================================

// `ref` rules mirror server/services/mediaCollections.js#sanitizeItem: ":"
// is the API key separator (`<kind>:<ref>` split on first ":"), so a ref
// containing one would be unaddressable for DELETE/coverKey lookups.
const mediaCollectionItemSchema = z.object({
  kind: z.enum(['image', 'video']),
  ref: z.string().trim().min(1).max(500).refine((s) => !s.includes(':'), {
    message: 'ref may not contain ":"',
  }),
}).strict();

// Remove keys are `<kind>:<ref>` strings the client already addresses items
// by — kept loose here (length cap only) because invalid keys are silently
// ignored by the service. Strict validation would force the client to filter
// stale selections itself.
const mediaCollectionRemoveKeySchema = z.string().min(3).max(520);

// Bulk endpoint: { add?, remove? } — at least one of the two arrays must be
// non-empty so a no-op call surfaces as a 400 instead of an opaque success.
export const mediaCollectionBulkItemsSchema = z.object({
  add: z.array(mediaCollectionItemSchema).max(1000).optional(),
  remove: z.array(mediaCollectionRemoveKeySchema).max(1000).optional(),
}).strict().refine(
  (d) => (Array.isArray(d.add) && d.add.length > 0) || (Array.isArray(d.remove) && d.remove.length > 0),
  { message: 'bulk update requires at least one item in add or remove' },
);
