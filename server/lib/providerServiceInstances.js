import { z } from 'zod';
import { harnessById } from './providerHarnesses.js';
import { isNonBlankStr } from './textUtils.js';
import {
  CATALOG_STRATEGIES,
  SERVICE_FAMILIES,
  SERVICE_PLANS,
  SERVICE_SLUG_RE,
  resolveServiceInstance,
  serviceDefinitionById,
  serviceDefinitionForLocalRuntime,
} from './serviceDefinitions.js';
import { nextConnectionCatalog } from './providerGraphRecords.js';

/**
 * The pure half of "a connection IS a service instance" (#7563, epic #7561).
 *
 * `ai_connections` rows predate `SERVICE_DEFINITIONS`: they carry a `kind`
 * derived from the executable record (`ollama`, `gateway:openrouter`, `api`,
 * `vendor`) and nothing that names the backend as a service. This module is
 * the bridge — how an existing row learns its definition, its default plan and
 * an addressable slug (the backfill the boot reconcile pass runs), how a new
 * instance created FROM a definition gets the `kind` reconciliation expects,
 * how a refresh outcome becomes the stored catalog, and the sanitized DTO
 * `GET /api/providers/services` publishes.
 *
 * Pure on purpose: no DB handle, no probe, no clock beyond the injected `now`,
 * so the backfill rule and the plan filter are pinned without a Postgres.
 */

/** How an instance authenticates. Only `stored` means a secret is on the row. */
export const SERVICE_CREDENTIAL_VIAS = Object.freeze(['stored', 'env', 'cli-login', 'bootstrap']);

/** Where the credential an instance runs under was found; mirrors `credentialInventory`'s vocabulary. */
export const SERVICE_CREDENTIAL_SOURCES = Object.freeze(['settings', 'env-file', 'env', 'cli', 'config', 'none']);

const GATEWAY_KIND = 'gateway:';

/**
 * The subscription (or harness-only) service a `vendor` connection stands for.
 *
 * A `vendor` row is one whose executable record names no daemon, no gateway
 * and no bare endpoint — the harness reaches its own cloud. Which cloud is a
 * fact about the HARNESS, so it is read off the harness's capability bindings:
 * the first binding naming a service that composes only onto this harness, or
 * failing that the first named service at all.
 */
function vendorDefinitionId(harnessId) {
  const harness = harnessById(harnessId);
  if (!harness) return null;
  const named = harness.bindings.filter((binding) => typeof binding.service === 'string');
  const own = named.find((binding) => serviceDefinitionById(binding.service)?.harnessOnly === harness.id);
  return (own ?? named[0])?.service ?? null;
}

/**
 * The `SERVICE_DEFINITIONS` id a connection `kind` maps to, or `null` for a
 * kind no definition describes.
 *
 * @param {string} kind - `ollama` | `gateway:<id>` | `api` | `vendor` | …
 * @param {{harnessId?: string|null}} [context] - the harness of a binding on the row
 */
export function definitionIdForKind(kind, { harnessId = null } = {}) {
  if (typeof kind !== 'string' || kind === '') return null;
  if (kind.startsWith(GATEWAY_KIND)) return serviceDefinitionById(kind.slice(GATEWAY_KIND.length))?.id ?? null;
  if (kind === 'api') return 'openai-compatible';
  if (kind === 'vendor') return vendorDefinitionId(harnessId);
  return serviceDefinitionForLocalRuntime(kind)?.id ?? null;
}

/**
 * The connection `kind` a definition's instances carry — the inverse of
 * {@link definitionIdForKind}, so a row created from a definition is judged by
 * reconciliation on exactly the terms an imported record would be.
 */
export function kindForDefinition(definition) {
  if (definition.localRuntime) return definition.localRuntime;
  if (definition.gateway) return `${GATEWAY_KIND}${definition.id}`;
  if (definition.family === 'subscription' || definition.harnessOnly) return 'vendor';
  return 'api';
}

/**
 * A slug not yet in `taken`: `base`, then `base-2`, `base-3`, …
 *
 * `taken` is mutated so one pass over many rows allocates distinct slugs
 * without re-reading the table between them.
 *
 * @param {string} base
 * @param {Set<string>} taken
 */
export function allocateServiceSlug(base, taken) {
  const root = SERVICE_SLUG_RE.test(base) ? base : 'service';
  let candidate = root;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${root}-${n}`;
  taken.add(candidate);
  return candidate;
}

/**
 * The service columns a row without them should carry.
 *
 * `plan` is the definition's FIRST plan — the same default `resolveServiceInstance`
 * applies — so a backfilled row and a freshly created one agree. A kind no
 * definition describes keeps `definitionId: null` but still gets a slug: the
 * row must stay addressable even when nothing composes onto it.
 *
 * @param {{kind: string}} connection
 * @param {{harnessId?: string|null, taken: Set<string>}} context
 * @returns {{slug: string, definitionId: string|null, plan: string}}
 */
export function serviceColumnsForConnection(connection, { harnessId = null, taken }) {
  const definitionId = definitionIdForKind(connection.kind, { harnessId });
  const definition = definitionId ? serviceDefinitionById(definitionId) : null;
  return {
    slug: allocateServiceSlug(definitionId ?? String(connection.kind || '').replace(GATEWAY_KIND, ''), taken),
    definitionId,
    plan: definition?.plans[0] ?? 'paid',
  };
}

/**
 * The backfill one reconcile pass applies: every connection with no `slug`
 * gets its service columns, allocated against the slugs the graph already
 * holds. Rows that have one are untouched, so a second pass plans nothing —
 * the "re-run is a no-op" half of the migration contract.
 *
 * @param {{connections: object[], bindings: object[]}} graph
 * @param {Set<string>} [taken] - slugs already allocated in this pass; defaults to the graph's own
 * @returns {{id: string, slug: string, definitionId: string|null, plan: string}[]}
 */
export function planServiceColumnBackfill(graph, taken = new Set(graph.connections.map((connection) => connection.slug).filter(Boolean))) {
  return graph.connections
    .filter((connection) => !connection.slug)
    .map((connection) => {
      const harnessId = graph.bindings.find((binding) => binding.connectionId === connection.id)?.harnessId ?? null;
      return { id: connection.id, ...serviceColumnsForConnection(connection, { harnessId, taken }) };
    });
}

/**
 * The transports map a stored row carries for a definition: the instance's
 * own overrides, else the definition's default base URL, and NO entry for a
 * protocol with neither — a `{ baseUrl: null }` row would read as an endpoint.
 */
export function transportsForDefinition(definition, overrides = {}) {
  return Object.fromEntries(Object.entries(resolveServiceInstance({ definition, transports: overrides }).transports)
    .filter(([, transport]) => typeof transport.baseUrl === 'string' && transport.baseUrl !== '')
    .map(([protocol, transport]) => [protocol, { baseUrl: transport.baseUrl }]));
}

/** The models a plan may list, per the definition's own filter. Identity when it has none. */
export const applyServicePlanFilter = (definition, plan, models) => (
  typeof definition?.catalog?.planFilter === 'function' ? definition.catalog.planFilter(plan, models) : models
);

/**
 * The catalog a service refresh leaves behind — `nextConnectionCatalog`'s
 * rule (a failure keeps what was known, a success writes what it saw) plus
 * `refreshedAt` and the per-model `capabilities` a listing declared. A failed
 * refresh keeps the previous capabilities with the previous models.
 *
 * @param {object} current - the stored catalog
 * @param {{refreshed: boolean, models?: string[], error?: string|null, contextWindows?: Record<string, number>|null}} outcome
 * @param {{now?: () => string}} [options]
 */
export function nextServiceCatalog(current, outcome, { now = () => new Date().toISOString() } = {}) {
  const next = nextConnectionCatalog(current, outcome);
  if (!outcome?.refreshed) {
    return { ...next, ...(current?.capabilities ? { capabilities: current.capabilities } : {}), refreshedAt: now() };
  }
  const windows = outcome.contextWindows && typeof outcome.contextWindows === 'object' ? outcome.contextWindows : {};
  const capabilities = Object.fromEntries(next.models
    .filter((model) => Number.isFinite(windows[model]))
    .map((model) => [model, { contextWindow: windows[model] }]));
  return { ...next, capabilities, refreshedAt: now() };
}

/** Whether a stored secret is on the row — the only `credentialVia` that holds one. */
export const serviceHasCredentials = (connection) => (
  (connection.credentialVia ?? 'stored') === 'stored' && Object.keys(connection.credentials || {}).length > 0
);

/**
 * Where the credential this instance runs under comes from, in
 * `credentialInventory`'s vocabulary — so a subscription instance can report
 * "signed in via CLI" without holding a key, and a `bootstrap` one "supplied by
 * the launch wrapper" (`config`). Never the value itself.
 *
 * @param {{credentialVia?: string, credentials?: object, definition?: object|null}} instance
 * @param {{env?: Record<string, string|undefined>, envFile?: Map<string, string>|null}} [sources]
 */
export function credentialSourceFor(instance, { env = {}, envFile = null } = {}) {
  const via = instance.credentialVia ?? 'stored';
  if (via === 'cli-login') return 'cli';
  if (via === 'bootstrap') return 'config';
  if (via === 'stored' && serviceHasCredentials(instance)) return 'settings';
  for (const name of instance.definition?.credential?.envVars ?? []) {
    if (isNonBlankStr(envFile?.get?.(name))) return 'env-file';
    if (isNonBlankStr(env[name])) return 'env';
  }
  return 'none';
}

// --- the sanitized service DTO ---------------------------------------------------

const definitionDtoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  family: z.enum(SERVICE_FAMILIES),
  plans: z.array(z.enum(SERVICE_PLANS)).min(1),
  catalogStrategy: z.enum(CATALOG_STRATEGIES),
  harnessOnly: z.string().nullable(),
}).strict();

/**
 * One instance as `GET /api/providers/services` publishes it. `.strict()` like
 * every graph DTO: a column added to the row must never ride out because a
 * mapper forgot to drop it, and `credentials` never appears at all.
 */
export const serviceDtoSchema = z.object({
  id: z.string().min(1),
  slug: z.string().nullable(),
  revision: z.number().int().positive(),
  label: z.string(),
  kind: z.string().min(1),
  definitionId: z.string().nullable(),
  definition: definitionDtoSchema.nullable(),
  plan: z.enum(SERVICE_PLANS),
  enabled: z.boolean(),
  transports: z.record(z.string(), z.object({ baseUrl: z.string().min(1) }).strict()),
  hasCredentials: z.boolean(),
  credentialVia: z.enum(SERVICE_CREDENTIAL_VIAS),
  credentialSource: z.enum(SERVICE_CREDENTIAL_SOURCES),
  catalog: z.object({
    state: z.enum(['unknown', 'known', 'failed']),
    models: z.array(z.string()),
    error: z.string().nullable().optional(),
    capabilities: z.record(z.string(), z.object({ contextWindow: z.number().optional() }).strict()).optional(),
    refreshedAt: z.string().optional(),
  }).strict(),
  bindingCount: z.number().int().nonnegative(),
  // One word a card can act on. `unknown-definition` is a row nothing composes
  // onto (a kind this release has no definition for), not a broken one.
  readiness: z.enum(['ready', 'disabled', 'needs-endpoint', 'needs-credential', 'unknown-definition']),
}).strict();

function serviceReadiness(connection, definition, credentialSource) {
  if (!definition) return 'unknown-definition';
  if (connection.enabled === false) return 'disabled';
  const declares = Object.keys(definition.transports);
  const reachable = declares.length === 0 || declares.some((protocol) => connection.transports?.[protocol]?.baseUrl);
  if (!reachable) return 'needs-endpoint';
  // A definition naming no conventional key variable (a bare OpenAI-compatible
  // endpoint) may honestly run keyless, so only a keyed vendor can be waiting on one.
  const needsKey = definition.family === 'api-key' && definition.credential.envVars.length > 0;
  return needsKey && credentialSource === 'none' ? 'needs-credential' : 'ready';
}

/**
 * @param {object} connection - a store row
 * @param {{bindingCount?: number, credentialSource?: string}} [context]
 */
export function toServiceDto(connection, { bindingCount = 0, credentialSource = 'none' } = {}) {
  const definition = connection.definitionId ? serviceDefinitionById(connection.definitionId) : null;
  return serviceDtoSchema.parse({
    id: connection.id,
    slug: connection.slug ?? null,
    revision: connection.revision,
    label: connection.label ?? '',
    kind: connection.kind,
    definitionId: connection.definitionId ?? null,
    definition: definition ? {
      id: definition.id,
      label: definition.label,
      family: definition.family,
      plans: [...definition.plans],
      catalogStrategy: definition.catalog.strategy,
      harnessOnly: definition.harnessOnly ?? null,
    } : null,
    plan: connection.plan ?? 'paid',
    enabled: connection.enabled ?? true,
    transports: connection.transports || {},
    hasCredentials: serviceHasCredentials(connection),
    credentialVia: connection.credentialVia ?? 'stored',
    credentialSource,
    catalog: connection.catalog || { state: 'unknown', models: [] },
    bindingCount,
    readiness: serviceReadiness(connection, definition, credentialSource),
  });
}
