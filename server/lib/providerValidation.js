/**
 * Zod schemas for AI provider routes: providers, connections, bindings, services, harnesses, credentials, presets, fallbacks and execution options.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { SERVICE_SLUG_RE, SERVICE_PLANS, SERVICE_CREDENTIAL_VIAS } from './serviceDefinitions.js';
import { MIN_TIMEOUT as AI_RUN_TIMEOUT_MIN_MS, MAX_TIMEOUT as AI_RUN_TIMEOUT_MAX_MS } from './aiToolkit/constants.js';
import { PROVIDER_HARNESS_IDS, ROUTE_MODES } from './provider/providerHarnesses.js';
import { emptyToUndefined, emptyToNull, providerRefSchema, presetProviderIdSchema } from './zodCompat.js';
import { EFFORT_LEVELS } from './provider/providerModels.js';
import { CREDENTIALS } from './credentialRegistry.js';
import { GOOGLE_CREDENTIAL_MAX_LENGTH } from './sharedSchemas.js';
import { isHeaderSafeKey, headerSafeKeyMessage } from './headerSafeKey.js';
import { parseProviderRef } from './provider/providerRef.js';
import { executionOptionsSchema } from './aiToolkit/internal/executionOptionsValidation.js';

// Provider schema
const providerHardwareRequirementsSchema = z.object({
  platforms: z.array(z.string().trim().min(1).max(32)).min(1).max(8).optional(),
  architectures: z.array(z.string().trim().min(1).max(32)).min(1).max(8).optional(),
  requiresAppleSilicon: z.boolean().optional(),
  requiresNvidiaGpu: z.boolean().optional(),
  minMemoryGb: z.number().positive().max(4096).optional(),
  minVramGb: z.number().positive().max(4096).optional(),
  minCudaComputeCapability: z.number().positive().max(20).optional(),
}).strict();

/** A service or bootstrap slug on a preset (#7565), clearable with `null`. */
const presetSlugField = z.string().trim().min(1).max(64).regex(SERVICE_SLUG_RE).nullable().optional();

export const providerSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['cli', 'api', 'tui']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  endpoint: z.string().url().optional(),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  hardwareRequirements: providerHardwareRequirementsSchema.optional(),
  modelHardwareRequirements: z.record(providerHardwareRequirementsSchema).optional(),
  defaultModel: z.string().nullable().optional(),
  timeout: z.number().int().min(AI_RUN_TIMEOUT_MIN_MS).max(AI_RUN_TIMEOUT_MAX_MS).optional(),
  enabled: z.boolean().optional(),
  // Marks a harness wrapper whose backend is the LM Studio server on this
  // machine. Unlike the containers below, its context window and reasoning are
  // chosen when the model instance is LOADED, so PortOS forwards neither.
  lmstudioBacked: z.boolean().optional(),
  // Kept in schema parity with aiToolkit's provider schema. Marks OpenCode
  // wrappers for a separately started local MTPLX native-MTP server.
  mtplxBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local llama.cpp
  // server (e.g. DFlash 2 speculative decoding).
  llamaBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local vLLM
  // container (the Qwen3.8-27B DFlash 2 stack on an RTX 3090).
  vllmBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a separately started local SGLang
  // container (Qwen3.8-27B on a Hopper/Blackwell card).
  sglangBacked: z.boolean().optional(),
  splashBacked: z.boolean().optional(),
  // Marks an OpenCode CLI/TUI wrapper for a hosted OpenAI-compatible gateway
  // ('orcarouter', 'openrouter', 'nvidia-nim' — see server/lib/provider/providerGateways.js). The
  // sibling API record whose id equals this value owns the key.
  gatewayBacked: z.string().optional(),
  // Legacy per-gateway marker, superseded by `gatewayBacked`. Still accepted and
  // still READ (providerGateways.js resolves it), because records written before
  // the registry existed are never rewritten — installs upgrade on their own
  // schedule.
  orcarouterBacked: z.boolean().optional(),
  // Explicit opt-in to attach the API key to an arbitrary (non-local,
  // non-allowlisted) endpoint — mirrors the aiToolkit providerSchema. Guards
  // SSRF / key exfiltration (server/lib/aiToolkit/endpointGuard.js).
  allowCustomEndpoint: z.boolean().optional(),
  // Kept in schema parity with aiToolkit's provider schema. Marks a CLI/TUI
  // provider whose harness auth is provisioned by an external CLI at spawn
  // time (a short-lived token for a proxy) rather than a static apiKey.
  // `setupCommand` is advisory only — PortOS never executes it. Nullable so
  // the editor can explicitly clear a previously-set bootstrap.
  credentialBootstrap: z.object({
    setupCommand: z.string().trim().max(500).optional(),
    command: z.string().trim().min(1).max(200),
    args: z.array(z.string().max(200)).max(20).optional(),
    envCommand: z.array(z.string().min(1).max(500)).min(1).max(21).optional(),
    harnessId: z.string().trim().min(1).max(100).optional(),
    argsSeparator: z.string().trim().max(20).optional(),
  }).strict().nullable().optional(),
  envVars: z.record(z.string()).optional(),
  headlessArgs: z.array(z.string()).optional(),
  tuiPromptDelayMs: z.number().int().min(250).max(60000).optional(),
  tuiIdleTimeoutMs: z.number().int().min(1000).max(86400000).optional(),
  // Kept in schema parity with aiToolkit's provider schema. This opt-in applies
  // only to interactive Claude TUI runs after the session-limit banner.
  lowPriorityOnUsageLimit: z.boolean().optional(),
  // Preset structure (#7565), in parity with the toolkit schema: the harness,
  // method and service slug a DERIVED preset is materialized from, the
  // optional catalog narrowing, and the bootstrap app it spawns through.
  harnessId: z.enum(PROVIDER_HARNESS_IDS).nullable().optional(),
  method: z.enum(ROUTE_MODES).nullable().optional(),
  serviceId: presetSlugField,
  catalogNarrowing: z.array(z.string().trim().min(1).max(512)).max(1000).nullable().optional(),
  credentialBootstrapId: presetSlugField,
});

// POST /api/providers/:id/test-vision.
export const providerVisionTestSchema = z.object({
  imagePath: z.string().trim().min(1).max(255),
  prompt: z.string().max(8_000).optional(),
  expectedContent: z.preprocess(emptyToUndefined, z.union([
    z.string().trim().min(1).max(128),
    z.array(z.string().trim().min(1).max(128)).max(50),
  ]).optional()),
  model: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(256).optional()),
});

// POST /api/providers/codex/account/login/cancel. The id is minted by the Codex
// app-server and only ever echoed back, so this bounds the shape and nothing
// more — the service still refuses an id that isn't the pending login's.
export const codexLoginCancelSchema = z.object({
  loginId: z.string().trim().min(1).max(200),
});

// POST /api/providers/codex/account/login. `deviceCode` picks the device-code
// flow (a URL plus a short code) over opening a browser URL directly.
export const codexLoginStartSchema = z.object({
  deviceCode: z.boolean().optional().default(false),
});

// POST /api/providers/model-pins/clear (#7315) — clear ONE stored model pin
// back to "inherit" by the id `GET /model-pins` reported. Addressed by pin id
// rather than a "clear everything stale" verb so an audit landing between the
// user's click and this write cannot widen what they approved. The id is
// resolved against a freshly collected pin list, so this bounds the shape only.
export const modelPinClearSchema = z.object({
  pinId: z.string().trim().min(1).max(300),
});

// POST /api/providers/connections (#6369) — a NEW backend.
//
// This schema bounds the SHAPE only. Which backend kinds and transport
// protocols are real is checked by `connectionBlocker` in the service, which
// already owns the harness/transport registries — importing them here would
// pull that subtree into the one module nearly every route validates through
// (`lib/importScoping.test.js`), for two enum lists and no extra safety.
//
// Exactly ONE transport, and this is the load-bearing rule: a provider record
// names one endpoint, so the profile a minted route reports always declares one
// transport. A connection declaring two would not be the connection its own
// routes describe, and reconciliation would clone each binding onto a fresh
// single-transport row on the next pass — silently undoing the create.
//
// Credentials take no `null` here, unlike the PATCH above: there is nothing yet
// to clear, so a null would only be a typo with a destructive reading.
export const providerConnectionCreateSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  transports: z.record(
    z.string().trim().min(1).max(64),
    z.object({ baseUrl: z.string().trim().min(1).max(2048) }).strict(),
  ).refine((value) => Object.keys(value).length === 1, {
    message: 'Declare exactly one transport protocol for this backend',
  }),
  credentials: z.record(
    z.string().trim().min(1).max(128),
    z.string().min(1).max(4096),
  ).optional().default({}),
}).strict();

// POST /api/providers/bindings (#6369) — a NEW harness configuration on an
// existing backend, and the executable routes it owns.
//
// `harnessId` accepts every registry id, not only the creatable ones: a harness
// with no command recipe gets the service's explanation of WHY it cannot be
// pointed at a backend, which is more useful than a schema enum error. `null`
// is the direct API binding and is spelled explicitly rather than by omission,
// because "no harness" is a real choice here, not a missing field.
export const providerBindingCreateSchema = z.object({
  connectionId: z.string().uuid(),
  harnessId: z.enum(PROVIDER_HARNESS_IDS).nullable(),
  modes: z.array(z.enum(ROUTE_MODES)).min(1).max(ROUTE_MODES.length)
    .refine((value) => new Set(value).size === value.length, { message: 'Name each mode once' }),
  label: z.string().trim().min(1).max(200).optional(),
}).strict();

// PATCH /api/providers/connections/:id (#6369).
//
// `expectedRevision` is REQUIRED, unlike the link schemas where a preview may
// omit it: this endpoint always writes, and a shared backend edit that lands on
// a row the human never saw is exactly the silent overwrite the graph exists to
// prevent.
//
// Credentials are three-valued on purpose — absent preserves, `null` clears, a
// string sets — so a client that never received the secret (the DTO carries
// only `hasCredentials`) can edit a label without wiping the key.
export const providerConnectionUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  label: z.string().trim().max(200).optional(),
  transports: z.record(
    z.string().trim().min(1).max(64),
    z.object({ baseUrl: z.string().trim().min(1).max(2048) }).strict(),
  ).optional(),
  credentials: z.record(z.string().trim().min(1).max(128), z.string().max(4096).nullable()).optional(),
}).strict();

// --- service instances (#7563) ------------------------------------------------
// The vocabulary comes from `serviceDefinitions.js`, a zero-import leaf this
// module already reaches, so nothing here can drift from the definitions.
const serviceSlugSchema = z.string().trim().min(1).max(64).regex(SERVICE_SLUG_RE, {
  message: 'A service slug is lowercase letters, digits and dashes, starting with a letter or digit',
});
const servicePlanSchema = z.enum(SERVICE_PLANS);
const serviceCredentialViaSchema = z.enum(SERVICE_CREDENTIAL_VIAS);

const serviceTransportsSchema = z.record(
  z.string().trim().min(1).max(64),
  z.object({ baseUrl: z.string().trim().min(1).max(2048) }).strict(),
);

// POST /api/providers/services — a NEW instance of a definition. The
// definition decides which transports and plans are legal (`resolveServiceInstance`
// in the service), so this bounds shape only. Credentials take no `null`, as
// on the connection create: nothing exists yet to clear.
export const providerServiceCreateSchema = z.object({
  definitionId: z.string().trim().min(1).max(64),
  slug: serviceSlugSchema.optional(),
  label: z.string().trim().min(1).max(200).optional(),
  plan: servicePlanSchema.optional(),
  enabled: z.boolean().optional(),
  transports: serviceTransportsSchema.optional(),
  credentials: z.record(z.string().trim().min(1).max(128), z.string().min(1).max(4096)).optional().default({}),
  credentialVia: serviceCredentialViaSchema.optional(),
}).strict();

// PATCH /api/providers/services/:slug — the connection update plus the
// instance's own plan / enabled / credential mode. Same three-valued
// credential rule, same required `expectedRevision`.
export const providerServiceUpdateSchema = providerConnectionUpdateSchema.extend({
  plan: servicePlanSchema.optional(),
  enabled: z.boolean().optional(),
  credentialVia: serviceCredentialViaSchema.optional(),
}).strict();

// --- credential pools on a service instance (#17384) ------------------------
// A pool key is EITHER a stored value or a reference to an env variable (the
// service checks the name against the definition), never both. Header-safe
// like every key sent as a bearer token.
// The strategy list and entry cap mirror `credentialPool.js` (pinned equal in
// its test) instead of importing it: this module is on the boot path, the pool
// logic loads only when a pool is used.
const CREDENTIAL_POOL_STRATEGIES = ['fill_first', 'round_robin', 'least_used'];
const CREDENTIAL_POOL_MAX_ENTRIES = 32;
const poolKeyLabelSchema = z.string().trim().min(1).max(120);
const poolCredentialIdSchema = z.string().trim().min(1).max(128);

export const credentialPoolKeyCreateSchema = z.object({
  label: poolKeyLabelSchema.optional(),
  apiKey: z.string().trim().min(8).max(4096)
    .refine(isHeaderSafeKey, { message: headerSafeKeyMessage('pool') })
    .optional(),
  envVar: z.string().trim().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/, { message: 'An env variable name is upper-case letters, digits and underscores' }).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Boolean(value.apiKey) !== Boolean(value.envVar), {
  message: 'Send exactly one of apiKey or envVar',
});

export const credentialPoolKeyUpdateSchema = z.object({
  label: poolKeyLabelSchema.optional(),
  enabled: z.boolean().optional(),
  rebindOrigin: z.literal(true).optional(),
}).strict();

export const CREDENTIAL_POOL_SCHEMA_LIMITS = Object.freeze({ strategies: CREDENTIAL_POOL_STRATEGIES, maxEntries: CREDENTIAL_POOL_MAX_ENTRIES });

export const credentialPoolSettingsSchema = z.object({
  strategy: z.enum(CREDENTIAL_POOL_STRATEGIES).optional(),
  order: z.array(poolCredentialIdSchema).max(CREDENTIAL_POOL_MAX_ENTRIES * 4).optional(),
}).strict();

export const credentialPoolResetSchema = z.object({
  credentialId: poolCredentialIdSchema.optional(),
}).strict();

// PATCH /api/providers/bindings/:id (#6369). Management state only: no
// `enabled`, because route enablement is an executable-record field that
// PATCH /api/providers/:id owns and a binding toggle must never grant it.
export const providerBindingUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  label: z.string().trim().max(200).optional(),
  selectedModels: z.array(z.string().trim().min(1).max(512)).max(1000).optional(),
}).strict();

// PATCH /api/providers/routes/:providerId (#6369) — ONE route's mode overrides.
//
// Deliberately not `providerSchema.partial()`: that would reopen the whole
// executable record, including the connection-owned endpoint/key the graph
// projects and the `enabled` flag that grants execution consent. The accepted
// keys are exactly the route-owned table in `providerRouteSettings.js`;
// `providerRouteSettings.test.js` fails if the two ever drift.
//
// `expectedRevision` is a FINGERPRINT of the values on disk, not a row counter
// — these fields live in providers.json, which the route editor and a model
// refresh also write. An empty patch is refused rather than written: it would
// rewrite the provider file to say nothing.
//
// `timeout` takes no `null`. The executable record's own schema has no null
// timeout, so storing one here would 400 the next save from the route editor;
// clearing a custom timeout stays that editor's job.
const nullableModelPin = z.preprocess(emptyToNull, z.string().trim().max(512).nullable());
export const providerRouteSettingsUpdateSchema = z.object({
  expectedRevision: z.string().trim().min(1).max(64),
  settings: z.object({
    args: z.array(z.string().trim().min(1).max(2048)).max(200).optional(),
    timeout: z.number().int().min(AI_RUN_TIMEOUT_MIN_MS).max(AI_RUN_TIMEOUT_MAX_MS).optional(),
    effort: z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable()).optional(),
    defaultModel: nullableModelPin.optional(),
    lightModel: nullableModelPin.optional(),
    mediumModel: nullableModelPin.optional(),
    heavyModel: nullableModelPin.optional(),
    ultraModel: nullableModelPin.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, {
    message: 'Name at least one setting to change',
  }),
}).strict();

// POST /api/providers/:id/vision-suite.
export const providerVisionSuiteSchema = z.object({
  model: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(256).optional()),
});

// POST /api/harnesses/action. Both values are TABLE KEYS, not free text: the
// service rejects a `runtime` that names no row and an `action` outside this
// enum before any child is spawned. This bounds the shape at the HTTP boundary
// so a malformed query fails as a 400 rather than as a lookup miss mid-stream.
export const harnessActionSchema = z.object({
  runtime: z.string().trim().min(1).max(64),
  action: z.enum(['install', 'update', 'uninstall']).optional().default('install'),
});

// POST /api/harnesses/models/refresh.
export const harnessRefreshSchema = z.object({
  runtime: z.string().trim().min(1).max(64),
});

export const privateCredentialParamsSchema = z.object({ id: z.enum(CREDENTIALS.filter(entry => entry.privateStore).map(entry => entry.id)) });
// Large enough for a Google Cloud service account JSON key (the Google credential).
const privateCredentialInputSchema = z.object({ value: z.string().trim().max(GOOGLE_CREDENTIAL_MAX_LENGTH) }).strict();

// Private-store ids whose value is sent verbatim in an HTTP header (label for the message).
const HEADER_CREDENTIAL_LABELS = Object.freeze({ fal: 'fal.ai', reactor: 'reactor.inc', runway: 'Runway', higgsfield: 'Higgsfield', 'google-cloud': 'Google' });

/**
 * PUT body for one private credential. Header-bound hosted keys are validated
 * untrimmed ('' clears), so an emoji, inner space or pasted trailing newline is
 * refused and the message names the setting; other credentials keep `trim()`.
 */
export const privateCredentialInputSchemaFor = (id) => {
  const label = HEADER_CREDENTIAL_LABELS[id];
  if (!label) return privateCredentialInputSchema;
  const allowJson = id === 'google-cloud';
  return z.object({
    value: z.string().max(GOOGLE_CREDENTIAL_MAX_LENGTH).refine(
      (v) => v === '' || isHeaderSafeKey(v) || (allowJson && v.trim().startsWith('{')),
      { message: headerSafeKeyMessage(label) },
    ).transform((v) => v.trim()),
  }).strict();
};

/**
 * `settings.harnesses` — per-harness enablement: `{ [harnessId]: { enabled } }`.
 * Keyed by a registry id only, so a typo cannot store a rule nothing reads. A
 * harness with no entry is enabled when its binary is detected on PATH
 * (`services/harnessEnablement.js`); `direct` is always enabled.
 */
// `partialRecord`: a Zod 4 `record` over an enum key is EXHAUSTIVE and would
// demand an entry for every harness.
export const harnessSettingsSchema = z.partialRecord(
  z.enum(PROVIDER_HARNESS_IDS),
  z.object({ enabled: z.boolean() }).strict(),
);

/**
 * One credential-bootstrap APP (#7564): the wrapper CLI that mints a harness's
 * credential at spawn (`<command> <args...> <harnessName> [<separator>] <harness args>`).
 * Same field limits as the inline `credentialBootstrap` a record carries
 * (`aiToolkit/validation.js`); `harnessNames` maps a harness id to the name the
 * wrapper knows it by when that differs from the binary (`claude` → `claude-code`).
 * `setupCommand` is advisory text — PortOS never runs it.
 */
const credentialBootstrapSchema = z.object({
  label: z.string().trim().min(1).max(100),
  command: z.string().trim().min(1).max(200),
  args: z.array(z.string().max(200)).max(20).optional(),
  envCommand: z.array(z.string().min(1).max(500)).min(1).max(21).optional(),
  argsSeparator: z.string().trim().max(20).optional(),
  setupCommand: z.string().trim().max(500).optional(),
  harnessNames: z.partialRecord(z.enum(PROVIDER_HARNESS_IDS), z.string().trim().min(1).max(100)).optional(),
}).strict();

/** `settings.credentialBootstraps` — apps keyed by the slug a composite id's `+<slug>` suffix names. */
export const credentialBootstrapsSettingsSchema = z.record(
  z.string().regex(SERVICE_SLUG_RE, 'bootstrap slug must be lowercase alphanumeric with hyphens').max(64),
  credentialBootstrapSchema,
);

/**
 * `POST /api/providers/presets` (#7565) — "Save as preset": a composite id
 * becomes a stored, derived preset. The composite's own grammar is checked
 * here; whether it is RUNNABLE (harness enabled, service known, compatible) is
 * the resolver's verdict, published as a 400 with its code. `effort` is
 * validated against the harness's ladder in the service, not against a flat
 * enum: which rungs exist is a per-harness (and per-model) fact.
 */
export const providerPresetCreateSchema = z.object({
  compositeId: providerRefSchema.refine((value) => parseProviderRef(value)?.kind === 'composite', {
    message: 'compositeId must be a composite <harness>.<cli|tui|api>@<service-slug>[+<bootstrap-slug>]',
  }),
  id: presetProviderIdSchema.optional(),
  name: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(512).nullable().optional(),
  effort: z.string().trim().min(1).max(20).nullable().optional(),
  executionOptions: executionOptionsSchema.optional(),
}).strict();

/** `PUT /api/providers/harnesses/:id` — flip one harness's enablement. */
export const harnessEnablementUpdateSchema = z.object({ enabled: z.boolean() }).strict();
export const harnessIdParamSchema = z.enum(PROVIDER_HARNESS_IDS);

// One step of the global provider fallback list. `providerId` is a preset or
// composite reference; `model` / `effort` are optional pins for that step, so
// one preset may appear several times with different models or effort.
const providerFallbackEntrySchema = z.object({
  providerId: providerRefSchema,
  model: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).max(200).optional()),
  effort: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).max(40).optional()),
});
export const providerFallbackChainBodySchema = z.object({
  entries: z.array(providerFallbackEntrySchema).max(50),
});

export const providerExecutionOptionsQuerySchema = z.object({ model: z.string().trim().max(512).optional(), refresh: z.enum(['true', 'false']).optional() }).strict();

export const executionOptionSelectionSchema = z.object({ model: z.string().trim().max(512).optional(), executionOptions: executionOptionsSchema }).strict();
