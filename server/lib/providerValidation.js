/**
 * Zod schemas for AI provider routes: providers, connections, bindings, services, harnesses, credentials, presets, fallbacks and execution options.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { PROVIDER_HARNESS_IDS } from './provider/providerHarnesses.js';
import { SERVICE_SLUG_RE, SERVICE_PLANS, SERVICE_CREDENTIAL_VIAS } from './serviceDefinitions.js';
import { emptyToUndefined, providerRefSchema, presetProviderIdSchema } from './zodCompat.js';
import { CREDENTIALS } from './credentialRegistry.js';
import { GOOGLE_CREDENTIAL_MAX_LENGTH } from './sharedSchemas.js';
import { isHeaderSafeKey, headerSafeKeyMessage } from './headerSafeKey.js';
import { parseProviderRef } from './provider/providerRef.js';
import { executionOptionsSchema } from './aiToolkit/internal/executionOptionsValidation.js';

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
// in the service), so this bounds shape only. A new service has no credentials to clear.
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

// PATCH /api/providers/services/:slug — omitted credentials preserve stored
// values, null clears them, and strings replace them.
export const providerServiceUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  label: z.string().trim().max(200).optional(),
  transports: serviceTransportsSchema.optional(),
  credentials: z.record(z.string().trim().min(1).max(128), z.string().max(4096).nullable()).optional(),
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
