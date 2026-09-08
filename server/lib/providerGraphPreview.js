import { z } from 'zod';
import { providerModeGroups } from './aiToolkit/internal/providerModes.js';
import {
  CONNECTION_ISOLATION_REASONS,
  CONNECTION_PROTOCOLS,
  compareBackendEndpoints,
  connectionBucketKey,
  providerConnectionProfile,
  sameConnectionIdentity,
  withConnectionOwnedFields,
  withoutConnectionOwnedFields,
} from './providerConnections.js';
import {
  PROVIDER_HARNESS_IDS,
  ROUTE_MODES,
  harnessForProvider,
  harnessSupportsMode,
  providerRouteMode,
  toCanonicalModelName,
} from './providerHarnesses.js';
import { isConfiguredDefaultModel } from './providerModels.js';

/**
 * READ-ONLY import preview for the provider connection graph proposed in
 * `docs/plans/2026-09-06-provider-connections-and-harnesses.md` (#6366).
 *
 * Given the provider records this install already runs, this answers what
 * connections, harness bindings and executable routes an import WOULD create —
 * and which records it would refuse to touch, with reasons. It persists
 * nothing, migrates nothing, and changes no execution path. Slices #6367-#6369
 * add the durable graph, the routing policy and the management UI on top.
 *
 * Two invariants make the preview trustworthy rather than merely informative:
 *
 *   1. **Every original route ID survives.** `routes` has exactly one entry per
 *      input provider, and {@link projectPreviewToProviders} reconstructs each
 *      original record — settings, pins, secrets and unknown custom fields
 *      included. A preview that cannot round-trip an install is a preview that
 *      would lose data on import.
 *   2. **Automatic grouping is limited to PROVEN same-harness siblings.** The
 *      binding grouping is `providerModeGroups` — the already-shipped
 *      CLI/TUI pairing — and nothing else. Two harnesses reaching one daemon
 *      are surfaced in `suggestedLinks`, never merged: cross-harness sharing
 *      requires an explicit link in a later slice.
 *
 * Nothing here performs I/O. Building a preview must never make a generation
 * call, probe a backend or launch a runtime.
 */

/** Wire version of the management DTOs. Bump with any breaking shape change. */
export const PROVIDER_GRAPH_SCHEMA_VERSION = 1;

/** Model pins a route can carry, in the order the management UI shows them. */
export const ROUTE_MODEL_PINS = Object.freeze([
  'defaultModel',
  'lightModel',
  'mediumModel',
  'heavyModel',
  'ultraModel',
  'fallbackModel',
]);

/** Why a route is not eligible to execute in its own mode. */
export const ROUTE_ELIGIBILITY_REASONS = Object.freeze([
  'mode-unsupported',
  'mode-not-allowed',
  'route-disabled',
  'consent-required',
]);

/** Why a stored model string or pin could not be resolved to the catalog. */
export const MODEL_RESOLUTION_REASONS = Object.freeze([
  'unmappable-model-alias',
  'pin-not-in-catalog',
]);

// --- version-1 management DTOs ----------------------------------------------
// `.strict()` throughout is a boundary guard, not tidiness: a field added to a
// provider record must never ride out to a client because a builder forgot to
// drop it. Validation failure is a bug in this module, so it throws.

const transportSchema = z.object({ baseUrl: z.string().min(1) }).strict();

// A record keyed by an enum is EXHAUSTIVE in zod 4 — every protocol would
// become required. A connection declares only the protocols it actually
// speaks, so the key set is checked rather than enumerated.
const transportsSchema = z.record(z.string(), transportSchema)
  .refine((value) => Object.keys(value).every((protocol) => CONNECTION_PROTOCOLS.includes(protocol)),
    { message: `transports keys must be one of: ${CONNECTION_PROTOCOLS.join(', ')}` });

const connectionDtoSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  kind: z.string().min(1),
  label: z.string(),
  transports: transportsSchema,
  hasCredentials: z.boolean(),
  catalog: z.object({
    state: z.enum(['unknown', 'known', 'failed']),
    models: z.array(z.string()),
  }).strict(),
}).strict();

const bindingDtoSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  variantKey: z.string().min(1),
  connectionId: z.string().min(1),
  harnessId: z.enum(PROVIDER_HARNESS_IDS).nullable(),
  label: z.string(),
  enabled: z.boolean(),
  selectedModels: z.array(z.string()),
}).strict();

const routeDtoSchema = z.object({
  providerId: z.string().min(1),
  bindingId: z.string().min(1).nullable(),
  mode: z.enum(ROUTE_MODES).nullable(),
  modelMap: z.record(z.string(), z.string()),
  unresolvedModels: z.array(z.object({
    model: z.string(),
    reason: z.enum(MODEL_RESOLUTION_REASONS),
  }).strict()),
  unresolvedPins: z.array(z.object({
    pin: z.enum(ROUTE_MODEL_PINS),
    model: z.string(),
    reason: z.enum(MODEL_RESOLUTION_REASONS),
  }).strict()),
  eligibility: z.object({
    mode: z.enum(ROUTE_MODES).nullable(),
    supported: z.boolean(),
    enabled: z.boolean(),
    consentRequired: z.boolean(),
    consentGranted: z.boolean(),
    eligible: z.boolean(),
    reasons: z.array(z.enum(ROUTE_ELIGIBILITY_REASONS)),
  }).strict(),
}).strict();

const unresolvedDtoSchema = z.object({
  providerId: z.string().min(1),
  reasons: z.array(z.object({
    code: z.enum(CONNECTION_ISOLATION_REASONS),
    detail: z.string(),
  }).strict()),
}).strict();

const suggestedLinkDtoSchema = z.object({
  connectionIds: z.array(z.string().min(1)).length(2),
  harnessIds: z.array(z.enum(PROVIDER_HARNESS_IDS).nullable()).length(2),
  reason: z.literal('same-backend-endpoint'),
  differences: z.array(z.string()),
  requiresExplicitLink: z.literal(true),
}).strict();

/** The full `GET /api/providers/management/preview` body. */
export const managementPreviewSchema = z.object({
  schemaVersion: z.literal(PROVIDER_GRAPH_SCHEMA_VERSION),
  activeProvider: z.string().nullable(),
  connections: z.array(connectionDtoSchema),
  bindings: z.array(bindingDtoSchema),
  routes: z.array(routeDtoSchema),
  unresolved: z.array(unresolvedDtoSchema),
  suggestedLinks: z.array(suggestedLinkDtoSchema),
}).strict();

// --- builder ----------------------------------------------------------------

/** Attach secret-bearing internals so a stray `JSON.stringify` cannot leak them. */
function hide(target, props) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(target, key, { value, enumerable: false, configurable: true });
  }
  return target;
}

/**
 * Whether this route may execute in its own mode, from the record alone.
 *
 * Deliberately NOT a routing policy — prerequisite probes and fallback
 * candidate selection need host I/O and belong to #6368. This is the pure,
 * declarative half: the harness supports the mode, the route is enabled, the
 * caller allows the mode, and any text-transport consent has been granted.
 * `allowedModes` is the caller's intersection; a CLI-only caller passing
 * `['cli']` can never receive a TUI route through it.
 *
 * @param {object} provider
 * @param {{allowedModes?: readonly string[]}} [options]
 */
export function routeModeEligibility(provider, { allowedModes = ROUTE_MODES } = {}) {
  const mode = providerRouteMode(provider);
  const harness = harnessForProvider(provider);
  // An `api` record is a direct API binding with no harness, so `api` support
  // comes from the record's own type rather than a harness row.
  const supported = mode === 'api' ? provider?.type === 'api' : harnessSupportsMode(harness?.id, mode);
  const enabled = provider?.enabled !== false;
  const consentRequired = typeof provider?.textTransport === 'string' && provider.textTransport !== '';
  const consentGranted = provider?.textTransportEnabled === true;

  const reasons = [];
  if (!supported) reasons.push('mode-unsupported');
  if (mode && !allowedModes.includes(mode)) reasons.push('mode-not-allowed');
  if (!enabled) reasons.push('route-disabled');
  if (consentRequired && !consentGranted) reasons.push('consent-required');

  return { mode, supported, enabled, consentRequired, consentGranted, eligible: reasons.length === 0, reasons };
}

/**
 * Canonical/executable model mapping, plus every stored alias that would not
 * resolve.
 *
 * An alias resolves only when the harness's own adapter maps the candidate back
 * to the exact stored string, so a bare `example-model` saved on an OpenCode
 * route — which needs its `<namespace>/` prefix to execute, and could equally
 * be a fully-qualified id for some other backend — is reported rather than
 * rewritten. That verified round-trip is also why two DIFFERENT stored strings
 * can never claim one canonical name: `modelMap` is keyed by canonical, so a
 * literal duplicate collapses and nothing else can collide.
 */
export function resolveRouteModels(provider) {
  const stored = Array.isArray(provider?.models) ? provider.models : [];
  const modelMap = {};
  const unresolvedModels = [];

  for (const entry of stored) {
    const { canonical, executable, resolved, reason } = toCanonicalModelName(provider, entry);
    if (resolved) modelMap[canonical] = executable;
    else if (!unresolvedModels.some((u) => u.model === entry)) unresolvedModels.push({ model: entry, reason });
  }

  const unresolvedPins = ROUTE_MODEL_PINS
    .filter((pin) => typeof provider?.[pin] === 'string' && provider[pin] !== ''
      && !isConfiguredDefaultModel(provider[pin])
      && stored.length > 0 && !stored.includes(provider[pin]))
    .map((pin) => ({ pin, model: provider[pin], reason: 'pin-not-in-catalog' }));

  return { modelMap, unresolvedModels, unresolvedPins };
}

/** A record's model catalog as a connection-level catalog with an honest state. */
function connectionCatalog(models) {
  // `[]` on a provider record cannot distinguish "never fetched" from
  // "fetched and legitimately empty", so it reads as `unknown` rather than
  // claiming a successful empty result the record does not attest to.
  return models.length > 0 ? { state: 'known', models } : { state: 'unknown', models: [] };
}

/**
 * Build the read-only import preview for a set of provider records.
 *
 * @param {{providers?: object[], activeProvider?: string|null}} data
 * @returns {object} preview — secret-bearing internals are non-enumerable
 */
export function buildProviderGraphPreview({ providers = [], activeProvider = null } = {}) {
  const records = Array.isArray(providers) ? providers.filter((p) => p && typeof p === 'object' && p.id) : [];
  const connections = [];
  const bindings = [];
  const routes = [];
  const unresolved = [];
  const buckets = new Map();
  const variantsByBinding = new Map();

  const isolate = (group, reasons) => {
    for (const provider of group) {
      unresolved.push({ providerId: provider.id, reasons });
      routes.push(hide({
        providerId: provider.id,
        bindingId: null,
        ...resolveRouteModels(provider),
        mode: providerRouteMode(provider),
        eligibility: routeModeEligibility(provider),
      }, { record: provider, routeRecord: provider, owned: null }));
    }
  };

  for (const group of providerModeGroups(records)) {
    const lead = group.find((provider) => provider.type === 'cli') || group[0];
    const harness = harnessForProvider(lead);
    const profiles = group.map((provider) => providerConnectionProfile(provider));
    const leadProfile = profiles[group.indexOf(lead)];

    // A sibling whose transport or credentials read differently from the lead's
    // is not the same connection, however conventional its id looks.
    const reasons = profiles.flatMap((profile) => profile.reasons);
    if (profiles.some((profile) => !sameConnectionIdentity(profile, leadProfile))) {
      reasons.push({ code: 'sibling-configuration-mismatch', detail: 'siblings disagree on backend kind, transport or credentials' });
    }
    // A record whose `type` names no executable mode cannot become a route.
    for (const provider of group.filter((candidate) => !providerRouteMode(candidate))) {
      reasons.push({ code: 'unknown-harness', detail: `unsupported type: ${provider.type ?? ''}` });
    }
    if (reasons.length > 0) {
      isolate(group, reasons);
      continue;
    }

    const harnessId = harness?.id ?? null;
    const bucketKey = connectionBucketKey(harnessId, leadProfile);
    const bucket = buckets.get(bucketKey) || [];
    // A record that declares NO transport (a vendor subscription harness, say)
    // offers no evidence about which backend it reaches, so it never shares a
    // connection with another group — matching endpoints is the only thing that
    // may make two records one connection, and "both named nothing" is not a
    // match. Its connection is exclusive to this binding.
    const sharable = Object.keys(leadProfile.transports).length > 0;
    let connection = sharable
      ? bucket.find((candidate) => sameConnectionIdentity(candidate.profile, leadProfile))
      : null;
    if (!connection) {
      connection = hide({
        id: `conn:${harnessId ?? 'api'}:${lead.id}`,
        revision: 1,
        kind: leadProfile.kind,
        label: String(lead.name || lead.id),
        transports: leadProfile.transports,
        hasCredentials: Object.keys(leadProfile.credentials).length > 0,
        catalog: connectionCatalog([]),
      }, { profile: leadProfile, harnessId });
      connections.push(connection);
      if (sharable) buckets.set(bucketKey, [...bucket, connection]);
    }

    // The connection's catalog is the union of what its bindings observe, by
    // canonical name — a shared catalog, never a per-route one.
    const resolvedModels = group.map((provider) => resolveRouteModels(provider));
    const unionModels = [...new Set([
      ...connection.catalog.models,
      ...resolvedModels.flatMap((resolved) => Object.keys(resolved.modelMap)),
    ])];
    connection.catalog = connectionCatalog(unionModels);

    // UNIQUE(connection_id, harness_id, variant_key): the first binding on a
    // connection is `default`; a second custom configuration of the same
    // harness on the same connection is a distinct labeled variant, never a
    // merge that would discard one of its executable route IDs.
    const variantScope = `${connection.id}|${harnessId ?? ''}`;
    const taken = variantsByBinding.get(variantScope) || [];
    // Prefixed so a provider literally named `default` cannot collide with the
    // first binding's reserved key.
    const variantKey = taken.length === 0 ? 'default' : `variant:${lead.id}`;
    variantsByBinding.set(variantScope, [...taken, variantKey]);

    const binding = {
      id: `binding:${lead.id}`,
      revision: 1,
      variantKey,
      connectionId: connection.id,
      harnessId,
      label: String(lead.name || lead.id),
      // OR across proven siblings, matching `unifyProviderModes`. Consent flags
      // never participate — they are per-route and never granted by grouping.
      enabled: group.some((provider) => provider.enabled === true),
      selectedModels: unionModels,
    };
    bindings.push(binding);

    for (const [index, provider] of group.entries()) {
      const profile = profiles[index];
      routes.push(hide({
        providerId: provider.id,
        bindingId: binding.id,
        ...resolvedModels[index],
        mode: providerRouteMode(provider),
        eligibility: routeModeEligibility(provider),
      }, {
        record: provider,
        routeRecord: withoutConnectionOwnedFields(provider, profile.owned),
        owned: profile.owned,
      }));
    }
  }

  const suggestedLinks = [];
  for (let i = 0; i < connections.length; i += 1) {
    for (let j = i + 1; j < connections.length; j += 1) {
      const [a, b] = [connections[i], connections[j]];
      if (a.harnessId === b.harnessId) continue;
      const { sameEndpoint, differences } = compareBackendEndpoints(a.profile, b.profile);
      if (!sameEndpoint) continue;
      suggestedLinks.push({
        connectionIds: [a.id, b.id],
        harnessIds: [a.harnessId, b.harnessId],
        reason: 'same-backend-endpoint',
        differences,
        requiresExplicitLink: true,
      });
    }
  }

  const preview = {
    schemaVersion: PROVIDER_GRAPH_SCHEMA_VERSION,
    activeProvider: typeof activeProvider === 'string' ? activeProvider : null,
    connections,
    bindings,
    routes,
    unresolved,
    suggestedLinks,
  };

  const violations = providerGraphUniquenessViolations(preview);
  if (violations.length > 0) {
    throw new Error(`Provider graph preview violates uniqueness: ${violations.join('; ')}`);
  }
  return preview;
}

/**
 * The uniqueness constraints the durable schema in #6367 will enforce, checked
 * here so a preview can never propose a graph the database would reject.
 *
 * @returns {string[]} one message per violation; empty means valid
 */
export function providerGraphUniquenessViolations(preview) {
  const violations = [];
  const seen = (label, keys) => {
    const counts = new Map();
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
    for (const [key, count] of counts) if (count > 1) violations.push(`${label} ${key} x${count}`);
  };

  seen('route provider_id', preview.routes.map((route) => route.providerId));
  seen('connection id', preview.connections.map((connection) => connection.id));
  seen('binding id', preview.bindings.map((binding) => binding.id));
  seen('(binding_id, mode)', preview.routes
    .filter((route) => route.bindingId)
    .map((route) => `${route.bindingId}|${route.mode}`));
  seen('(connection_id, harness_id, variant_key)', preview.bindings
    .filter((binding) => binding.harnessId !== null)
    .map((binding) => `${binding.connectionId}|${binding.harnessId}|${binding.variantKey}`));
  // The partial unique index for null-harness (direct API) bindings.
  seen('(connection_id, variant_key) [api]', preview.bindings
    .filter((binding) => binding.harnessId === null)
    .map((binding) => `${binding.connectionId}|${binding.variantKey}`));
  return violations;
}

/**
 * The sanitized, validated body a client receives.
 *
 * Credentials, raw provider records and the connection-owned snapshots never
 * appear: the browser is told only WHETHER a connection has credentials, and
 * every identity decision was already made server-side on real values.
 */
export function toManagementPreviewDto(preview) {
  return managementPreviewSchema.parse({
    schemaVersion: preview.schemaVersion,
    activeProvider: preview.activeProvider,
    connections: preview.connections.map(({ id, revision, kind, label, transports, hasCredentials, catalog }) =>
      ({ id, revision, kind, label, transports, hasCredentials, catalog })),
    bindings: preview.bindings,
    routes: preview.routes.map(({ providerId, bindingId, mode, modelMap, unresolvedModels, unresolvedPins, eligibility }) =>
      ({ providerId, bindingId, mode, modelMap, unresolvedModels, unresolvedPins, eligibility })),
    unresolved: preview.unresolved,
    suggestedLinks: preview.suggestedLinks,
  });
}

/**
 * Re-materialize the executable provider records from a preview.
 *
 * This is the import-fidelity proof AND the downgrade contract in one function:
 * an install that drops back to a graph-unaware release runs
 * `data/providers.json` alone, so every connection-owned value has to be
 * present in the executable record. Round-tripping must reproduce each input
 * record exactly — including pins, secrets, consent flags and unknown custom
 * fields this module has never heard of.
 *
 * @returns {Record<string, object>} keyed by the original provider id
 */
export function projectPreviewToProviders(preview) {
  return Object.fromEntries(preview.routes.map((route) => [
    route.providerId,
    route.owned ? withConnectionOwnedFields(route.routeRecord, route.owned) : route.record,
  ]));
}
