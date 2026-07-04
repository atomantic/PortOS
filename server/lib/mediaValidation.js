/**
 * Media-generation & local-model infrastructure Zod schemas (split out of
 * validation.js, issue #1831).
 *
 * Covers LoRA training config + run params, the local-LLM (Ollama / LM Studio)
 * backend management routes, CyberCity snapshot config/query, and the media-
 * collection bulk add/remove payloads. validation.js re-exports everything here
 * (flat) so existing deep imports keep working; the barrel surfaces it as the
 * `mediaValidation` namespace.
 */
import { z } from 'zod';

// CyberCity snapshot pipeline (issue #877): how often to capture a city-state
// frame and how many to retain. Validated as a settings slice on PUT /api/settings;
// service-side defaults (DEFAULT_SNAPSHOT_CONFIG) fill any absent field so an
// install with no `citySnapshots` key still captures.
export const citySnapshotConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(1).max(1440).optional(),
  maxSnapshots: z.number().int().min(10).max(100000).optional()
});

// iMessage ingestion config (#2151) — the `settings.imessage` slice. Sync is OFF
// by default and only reads chat.db when enabled (needs macOS Full Disk Access).
// Validated as a settings slice on PUT /api/settings; service-side DEFAULT_CONFIG
// fills any absent field so an install with no `imessage` key still resolves.
export const imessageConfigSchema = z.object({
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

// Query for GET /api/city/snapshots — `since` (ISO timestamp) and `limit`
// (most-recent N) both arrive as strings on the query string.
export const citySnapshotsQuerySchema = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100000).optional()
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
