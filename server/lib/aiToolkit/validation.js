import { executionOptionsSchema } from './internal/executionOptionsValidation.js';
import { LOCAL_RUNTIME_MARKER_KEYS } from './internal/localRuntimeMarkers.js';
import { z } from 'zod';
import { MAX_MODEL_ACCESS_PATTERNS, MAX_MODEL_ACCESS_PATTERN_LENGTH, MODEL_ACCESS_MODES } from './internal/modelAccess.js';
import { basename, extname } from 'path';
import { MAX_TIMEOUT, MIN_TIMEOUT } from './constants.js';
import { MAX_PROVIDER_REF_LENGTH, PRESET_ID_RE, PRESET_ONLY_MESSAGE, parseProviderRef } from './internal/providerRef.js';

/**
 * A run's provider selection: a preset record id or a composite reference the
 * host resolves through `resolveCompositeProvider`. Mirrors the host's
 * `providerRefSchema` (`server/lib/zodCompat.js`) over the vendored grammar.
 */
export const providerRefSchema = z.string().trim().min(1).max(MAX_PROVIDER_REF_LENGTH)
  .refine((value) => parseProviderRef(value) !== null, 'providerId must be a preset id or a composite <harness>.<cli|tui|api>@<service-slug>[+<bootstrap-slug>]');

// OpenRouter `provider` routing preferences; resolved into the request body by
// `resolveOpenRouterProviderField` (internal/generationOptions.js).
// Slugs are lowercased before the shape check so ' Anthropic ' is accepted.
const routingSlugList = z.array(z.string().trim().toLowerCase().min(1).max(80)).max(32);
const routingFields = {
  sort: z.enum(['price', 'throughput', 'latency']).nullable().optional(),
  only: routingSlugList.optional(),
  ignore: routingSlugList.optional(),
  order: routingSlugList.optional(),
  require_parameters: z.boolean().optional(),
  data_collection: z.enum(['allow', 'deny']).nullable().optional(),
};
export const providerRoutingSchema = z.object({
  ...routingFields,
  // Per-model overrides merge OVER the flat defaults for the matching model only.
  models: z.record(z.string().trim().min(1).max(300), z.object(routingFields).strict()).optional(),
}).strict();

// Mirrors the runner's getMimeType keys; anything else is rejected.
const ALLOWED_SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Local mirror (toolkit is self-contained) of server/lib/provider/providerModels.js and client/src/utils/providerModels.js.
const PROVIDER_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const providerEffort = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z.enum(PROVIDER_EFFORT_LEVELS).nullable().optional()
);

// Declarative, machine-local; bounded so a record cannot become an arbitrary JSON payload.
const providerHardwareRequirementsSchema = z.object({
  platforms: z.array(z.string().trim().min(1).max(32)).min(1).max(8).optional(),
  architectures: z.array(z.string().trim().min(1).max(32)).min(1).max(8).optional(),
  requiresAppleSilicon: z.boolean().optional(),
  requiresNvidiaGpu: z.boolean().optional(),
  minMemoryGb: z.number().positive().max(4096).optional(),
  minVramGb: z.number().positive().max(4096).optional(),
  minCudaComputeCapability: z.number().positive().max(20).optional(),
}).strict();

/**
 * Sanitize the untrusted `screenshots[]` array from POST /api/runs into safe,
 * screenshots-dir-relative basenames. The vision loader base64-encodes each
 * entry and forwards it to the external provider, so `../../etc/passwd` or an
 * absolute path would exfiltrate an arbitrary readable file. `basename`
 * collapses every directory component and the extension allow-list rejects
 * non-image references before any file is read. Lives here (not the shared
 * loadImageAsBase64) so trusted in-process callers passing absolute paths from
 * other image roots keep working; only the HTTP boundary is constrained.
 *
 * @param {unknown} screenshots
 * @returns {{ safe: string[], rejected: string[] }}
 */
export function sanitizeScreenshotRefs(screenshots) {
  const safe = [];
  const rejected = [];
  if (!Array.isArray(screenshots)) return { safe, rejected };
  for (const entry of screenshots) {
    if (typeof entry !== 'string' || !entry) {
      rejected.push(String(entry));
      continue;
    }
    const name = basename(entry);
    if (!name || name === '.' || name === '..' ||
        !ALLOWED_SCREENSHOT_EXTENSIONS.has(extname(name).toLowerCase())) {
      rejected.push(entry);
      continue;
    }
    safe.push(name);
  }
  return { safe, rejected };
}

/** A service or bootstrap slug on a preset (#7565): the same alphabet as a record id, clearable with `null`. */
const presetSlugField = z.string().regex(PRESET_ID_RE, 'must be a slug (lowercase alphanumeric with hyphens)').max(64).nullable().optional();

export const providerSchema = z.object({
  // Sample providers post a stable id so the server adopts it verbatim rather than slugifying the name.
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase alphanumeric with hyphens').max(80).optional(),
  name: z.string().min(1).max(100),
  type: z.enum(['cli', 'api', 'tui']),
  command: z.string().trim().optional(),
  args: z.array(z.string()).optional(),
  // CLI forms send `endpoint: ''`; coerce so the URL check only runs for real values.
  endpoint: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string().url().optional()
  ),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  // Optional hardware gates; the host also infers requirements, so old records need no migration.
  hardwareRequirements: providerHardwareRequirementsSchema.optional(),
  modelHardwareRequirements: z.record(providerHardwareRequirementsSchema).optional(),
  defaultModel: z.string().nullable().optional(),
  // Empty string is the UI's "use the provider/CLI default" sentinel.
  effort: providerEffort,
  executionOptions: executionOptionsSchema.optional(),
  executionSourceProviderId: providerRefSchema.optional(),
  executionSelectionRoot: z.boolean().optional(),
  lightModel: z.string().nullable().optional(),
  mediumModel: z.string().nullable().optional(),
  heavyModel: z.string().nullable().optional(),
  ultraModel: z.string().nullable().optional(),
  // PRESET-ONLY: the fallback chain reads `providers[fallbackProvider]` off the
  // stored map, where a composite never exists. `''` is the picker's "None"
  // sentinel and every ProviderForm save sends it. Refine rather than a union so
  // the refusal keeps naming the rule.
  fallbackProvider: z.string().max(80).refine((value) => value === '' || PRESET_ID_RE.test(value), PRESET_ONLY_MESSAGE).nullable().optional(),
  // The UI sends '' when no model is pinned.
  fallbackModel: z.string().nullable().optional(),
  // Per-request context window (Ollama num_ctx). Lifts the ~4K default so long
  // prompts (e.g. a whole manuscript) aren't silently truncated. Null = unset.
  numCtx: z.number().int().min(512).max(1048576).nullable().optional(),
  // Per-model num_ctx overrides keyed by model id; each replaces numCtx for
  // that model only (a 1M-token model next to 128K ones on one daemon).
  modelNumCtx: z.record(z.string().min(1).max(300), z.number().int().min(512).max(1048576)).optional(),
  // OpenRouter `provider` routing preferences (sort, allow/deny lists, data
  // collection, per-model overrides); sent only to OpenRouter endpoints. Null clears.
  providerRouting: providerRoutingSchema.nullable().optional(),
  // Default generation controls for local OpenAI-compatible backends and their
  // OpenCode wrappers; a run may override per task. Nullable: null is "unset"
  // (the backend keeps its own), so the editor can remove a pin.
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  thinking: z.boolean().nullable().optional(),
  // Planning-time context window (tokens) the editorial budgeter may assume for
  // this provider — distinct from numCtx (what we *ask Ollama for*). For cloud
  // providers numCtx stays null and this reflects the model's real ceiling.
  contextWindow: z.number().int().min(512).max(2097152).nullable().optional(),
  // Harness budget, not daemon allocation or PortOS planning. OpenCode pins
  // one explicit model; Claude Code's environment applies across the preset.
  harnessContext: z.union([z.object({
    tokens: z.number().int().min(512).max(2097152),
    model: z.string().trim().min(1).max(300).optional(),
  }).strict(), z.object({ followRuntime: z.literal(true) }).strict()]).nullable().optional(),
  // Per-model context windows read from the provider's `/models` catalog, written
  // by model refresh; beats the hardcoded table, loses to `contextWindow`. The
  // ceiling is wider than `contextWindow`'s because it must accept whatever a
  // vendor declares, or a 10M-window model would 400 the whole provider write.
  modelContextWindows: z.record(z.number().int().min(512).max(33554432)).optional(),
  // Plan/tier scope of the advertised catalog (internal/modelAccess.js), applied
  // on the way OUT; the stored `models` is never narrowed. Nullable to clear
  // (absent means "unchanged" on a PATCH).
  modelAccess: z.object({
    mode: z.enum(MODEL_ACCESS_MODES),
    // An EMPTY list is valid ("no constraint yet"), so the mode can be saved before the list is typed.
    patterns: z.array(z.string().trim().min(1).max(MAX_MODEL_ACCESS_PATTERN_LENGTH))
      .max(MAX_MODEL_ACCESS_PATTERNS).optional(),
  }).strict().nullable().optional(),
  timeout: z.number().int().min(MIN_TIMEOUT).max(MAX_TIMEOUT).optional(),
  enabled: z.boolean().optional(),
  // A CLI/TUI provider that can ALSO serve plain text through a non-HTTP
  // transport (today only `codex-app-server`). A string so a second transport is
  // a new value, not a contradicting flag. Only ADVERTISES the capability.
  textTransport: z.enum(['codex-app-server']).nullable().optional(),
  // Explicit opt-in (default off, separate from `enabled`) so a fresh install
  // never bills a subscription for a feature the user has not pointed at it.
  textTransportEnabled: z.boolean().optional(),
  // The read-only sandbox blocks writes but not absolute-path reads; separate so
  // the transport cannot be enabled without recording explicit consent.
  textTransportReadRiskAcknowledged: z.boolean().optional(),
  // The local-runtime markers (ollama, lmstudio, mtplx, llama, vllm, sglang, splash), one
  // boolean per runtime from internal/localRuntimeMarkers.js. They are not interchangeable:
  // engines, ports and protocol config differ, and e.g. LM Studio fixes its context window at
  // model LOAD (`localRuntimeNamespace` in ../provider/providerModels.js).
  ...Object.fromEntries(LOCAL_RUNTIME_MARKER_KEYS.map((key) => [key, z.boolean().optional()])),
  // Wrapper for a hosted OpenAI-compatible gateway (see internal/gateways.js);
  // its API key is read from the sibling API record of the SAME id at
  // spawn/refresh time and never stored here.
  gatewayBacked: z.string().optional(),
  // Legacy per-gateway marker, still read forever: stored records are never
  // rewritten, since installs upgrade on their own schedule.
  orcarouterBacked: z.boolean().optional(),
  // Explicit opt-in to attach the API key to a non-local, non-allowlisted
  // endpoint (SSRF / key exfiltration guard, see endpointGuard.js). Metadata
  // endpoints stay blocked even when true.
  allowCustomEndpoint: z.boolean().optional(),
  // Append `--ignore-user-config` to a Codex spawn so the user's
  // `~/.codex/config.toml` cannot re-point model routing. Default OFF to keep
  // existing installs' behavior.
  ignoreUserConfig: z.boolean().optional(),
  // Codex authentication method pin (`forced_login_method`): 'chatgpt' = the
  // ChatGPT subscription, 'api' = API-key billing. Absent/null = Codex decides
  // from its own login state. Some models are available to only one method.
  codexAuthMode: z.enum(['chatgpt', 'api']).nullable().optional(),
  // A CLI/TUI provider whose harness auth is provisioned by an external CLI at
  // spawn time: PortOS spawns `command`(+`args`) in front of the harness
  // (`<bootstrap> run <harness> ...`). `setupCommand` is advisory only; PortOS
  // never executes it. Nullable to clear (absent means "unchanged" on a PATCH).
  credentialBootstrap: z.object({
    setupCommand: z.string().trim().max(500).optional(),
    command: z.string().trim().min(1).max(200),
    args: z.array(z.string().max(200)).max(20).optional(),
    envCommand: z.array(z.string().min(1).max(500)).min(1).max(21).optional(),
    // The wrapper CLI's own name for the harness (e.g. `claude-code` for binary
    // `claude`); defaults to `command`.
    harnessId: z.string().trim().min(1).max(100).optional(),
    // Inserted between the harness identifier and the harness's OWN args.
    argsSeparator: z.string().trim().max(20).optional(),
  }).strict().nullable().optional(),
  envVars: z.record(z.string()).optional(),
  secretEnvVars: z.array(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional(),
  tuiPromptDelayMs: z.number().int().min(250).max(60000).optional(),
  tuiIdleTimeoutMs: z.number().int().min(1000).max(86400000).optional(),
  // Claude Code's hidden `/low-priority` command is available only from its
  // interactive TUI after a session usage limit. It is an explicit opt-in
  // because continuation can draw on weekly usage.
  lowPriorityOnUsageLimit: z.boolean().optional(),
  // PRESET structure: a record with all of `harnessId`, `method` and `serviceId`
  // is a DERIVED preset, re-materialized from its service instance on every save
  // (`server/lib/provider/providerPresets.js`); without them it is a legacy preset.
  // Nullable so an editor can clear them. `method` must equal `type`, enforced
  // by the host (a refinement here would not survive `.partial()` / `.extend()`).
  // Slugs, not enums, because the toolkit is self-contained.
  harnessId: z.string().regex(/^[a-z0-9-]+$/, 'harnessId must be a harness id').max(64).nullable().optional(),
  method: z.enum(['cli', 'tui', 'api']).nullable().optional(),
  serviceId: presetSlugField,
  // The subset of the service catalog this preset offers; `null` = the whole catalog.
  catalogNarrowing: z.array(z.string().trim().min(1).max(512)).max(1000).nullable().optional(),
  // The configured credential-bootstrap app (`settings.credentialBootstraps`
  // slug) a derived cli/tui preset spawns through; materialization writes the
  // inline `credentialBootstrap` object from it.
  credentialBootstrapId: presetSlugField,
});

/**
 * What ONE mode of a dual-mode create may set for itself.
 *
 * Rules are taken from `providerSchema`'s own shape so bounds cannot drift. The
 * set is deliberately small: anything NOT here is shared by both records, which
 * keeps the pair groupable (`providerModeGroups` refuses siblings that disagree
 * on command, endpoint, credentials or env; keys must stay clear of
 * {@link MODE_GROUPED_KEYS}).
 */
const providerModeOverrideSchema = z.object({
  args: providerSchema.shape.args,
  headlessArgs: providerSchema.shape.headlessArgs,
  tuiPromptDelayMs: providerSchema.shape.tuiPromptDelayMs,
}).strict();

/** The keys {@link providerModeOverrideSchema} lets a mode vary. */
export const PROVIDER_MODE_OVERRIDE_KEYS = Object.freeze(Object.keys(providerModeOverrideSchema.shape));

/**
 * POST /api/providers — the create body, which may declare BOTH execution modes
 * of one harness. Both keys are required: the map's presence IS the "make me a
 * pair" request (an empty `cli: {}` is normal; the body's own args describe the
 * CLI record). The optional per-mode arguments belong to their own map entry.
 *
 * Create-only and absent from `providerSchema`: a PATCH of one existing record
 * cannot mean "mint a pair", so `providerSchema.partial()` drops the key.
 */
export const providerCreateSchema = providerSchema.extend({
  modes: z.object({
    cli: providerModeOverrideSchema,
    tui: providerModeOverrideSchema,
  }).strict().optional(),
});


// PUT /api/providers/active. The slug shape keeps `__proto__` from reaching the
// `data.providers[id]` lookup in setActiveProvider, which walks the prototype chain.
export const providerActiveSchema = z.object({
  id: z.string().regex(PRESET_ID_RE, PRESET_ONLY_MESSAGE).max(80)
});

export const runSchema = z.object({
  type: z.enum(['ai', 'command']).optional().default('ai'),
  providerId: providerRefSchema.optional(),
  model: z.string().optional(),
  executionOptions: executionOptionsSchema.optional(),
  workspacePath: z.string().optional(),
  workspaceName: z.string().optional(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
  timeout: z.number().int().min(MIN_TIMEOUT).max(MAX_TIMEOUT).optional()
});

// Prompt routes: free-form maps stay `z.record`; a wrong-typed top level bounces as a 400.
export const promptStageUpdateBodySchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  template: z.string().optional()
});
export const promptPreviewBodySchema = z.record(z.string(), z.unknown());
export const promptVariableCreateBodySchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]+$/, 'invalid variable key').max(80)
}).catchall(z.unknown());
export const promptVariableUpdateBodySchema = z.record(z.string(), z.unknown());

// `waitTime` is regex-matched downstream; a non-string would 500 there.
export const providerUsageLimitBodySchema = z.object({
  message: z.string().optional(),
  waitTime: z.string().optional()
});

// GET /runs and DELETE /runs query strings: scalar strings only; the route keeps its lenient
// number parsing and ignores unknown keys so older clients keep working.
export const runsListQuerySchema = z.object({
  limit: z.string().optional(),
  offset: z.string().optional(),
  source: z.string().optional()
});
export const runsBulkDeleteQuerySchema = z.object({ filter: z.string().optional() });

export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(e => ({
      path: e.path.join('.'),
      message: e.message
    }))
  };
}
