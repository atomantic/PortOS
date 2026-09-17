import { z } from 'zod';
import { harnessById } from './providerHarnesses.js';
import { CONNECTION_CREDENTIAL_ENV_VARS } from './providerConnections.js';
import { connectionDtoSchema, connectionHasCredentials, toConnectionDto } from './providerGraphRecords.js';
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

/**
 * The pure half of "a connection IS a service instance" (#7563, epic #7561).
 *
 * `ai_connections` rows predate `SERVICE_DEFINITIONS`: they carry a `kind`
 * derived from the executable record (`ollama`, `gateway:openrouter`, `api`,
 * `vendor`) and nothing that names the backend as a service. This module is
 * the bridge — how an existing row learns its definition, its default plan and
 * an addressable slug (the backfill the boot reconcile pass runs), how a new
 * instance created FROM a definition gets the `kind` reconciliation expects,
 * which models a plan may list, where an instance's credential comes from, and
 * the sanitized DTO `GET /api/providers/services` publishes.
 *
 * Pure on purpose: no DB handle, no probe, no clock, so the backfill rule and
 * the plan filter are pinned without a Postgres.
 */

/** Where a credential was found; `credentialInventory`'s vocabulary, so the two surfaces agree. */
const CREDENTIAL_SOURCES = Object.freeze(['settings', 'env-file', 'env', 'cli', 'config', 'none']);

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
 * reconciliation on exactly the terms an imported record would be. (Not
 * `providerRouteRecipes`' `serviceConnectionKind`, which answers a different
 * question — the OpenCode namespace — and falls back to the slug.)
 */
export function kindForDefinition(definition) {
  if (definition.localRuntime) return definition.localRuntime;
  if (definition.gateway) return `${GATEWAY_KIND}${definition.id}`;
  if (definition.family === 'subscription' || definition.harnessOnly) return 'vendor';
  return 'api';
}

/**
 * The key an instance runs under, or `''`. A `stored` instance holds it on the
 * row (under `apiKey`, or under the env var name a route-derived row kept); an
 * `env` one reads the definition's conventional variable from the process; a
 * `cli-login` or `bootstrap` instance holds none — the program signs in, or the
 * launch wrapper supplies it.
 *
 * @param {{credentialVia?: string, credentials?: object}} connection
 * @param {{credential: {envVars: readonly string[]}}} definition
 * @param {Record<string, string|undefined>} env
 */
export function instanceApiKeyFor(connection, definition, env) {
  const firstNamed = (bag, names) => names.map((name) => bag?.[name]).find(isNonBlankStr) ?? '';
  const via = connection.credentialVia ?? 'stored';
  if (via === 'env') return firstNamed(env, definition.credential.envVars);
  if (via !== 'stored') return '';
  const stored = connection.credentials || {};
  if (isNonBlankStr(stored.apiKey)) return stored.apiKey;
  // A route-derived row keeps its key under the env var the record carried
  // (`ANTHROPIC_AUTH_TOKEN` on a Claude-Ollama import), which a local daemon's
  // definition names no conventional variable for — so every credential
  // variable the profile reads is a place the key may sit, after the
  // definition's own.
  return firstNamed(stored, [...definition.credential.envVars, ...CONNECTION_CREDENTIAL_ENV_VARS]);
}

/**
 * The pure instance shape behind a connection row: its definition, slug, plan,
 * endpoints and the key it runs under. `null` when the row names no definition
 * this build has (nothing composes onto it).
 *
 * A stored row OUTLIVES the definition it names: installs upgrade on their own
 * schedule, so a release that drops or renames a plan leaves existing rows on
 * the old one. `resolveServiceInstance` THROWS on a plan the definition no
 * longer sells (and on a slug that predates `SERVICE_SLUG_RE`), and the
 * composition catalog maps this over EVERY connection — so one stale row would
 * take down the whole surface instead of dropping the single service it
 * describes. Answer `null` for it, exactly as for an unknown definition.
 *
 * @param {object} connection - a store row
 * @param {Record<string, string|undefined>} [env]
 */
export function instanceForConnection(connection, env = process.env) {
  const definition = connection?.definitionId ? serviceDefinitionById(connection.definitionId) : null;
  if (!definition || !connection.slug) return null;
  const plan = connection.plan ?? definition.plans[0];
  if (!definition.plans.includes(plan) || !SERVICE_SLUG_RE.test(connection.slug)) return null;
  const apiKey = instanceApiKeyFor(connection, definition, env);
  return resolveServiceInstance({
    definition,
    slug: connection.slug,
    plan: connection.plan,
    transports: connection.transports,
    credentials: apiKey ? { apiKey } : {},
    credentialVia: connection.credentialVia,
  });
}

/** The slugs a graph already uses — what every allocation must avoid. */
export const takenServiceSlugs = (connections) => new Set(connections.map((connection) => connection.slug).filter(Boolean));

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
 * gets its service columns, allocated against `taken`. Rows that have one are
 * untouched, so a second pass plans nothing — the "re-run is a no-op" half of
 * the migration contract.
 *
 * @param {{connections: object[], bindings: object[]}} graph
 * @param {Set<string>} taken - slugs already allocated in this pass
 * @returns {{id: string, slug: string, definitionId: string|null, plan: string}[]}
 */
export function planServiceColumnBackfill(graph, taken) {
  return graph.connections
    .filter((connection) => !connection.slug)
    .map((connection) => {
      const harnessId = graph.bindings.find((binding) => binding.connectionId === connection.id)?.harnessId ?? null;
      return { id: connection.id, ...serviceColumnsForConnection(connection, { harnessId, taken }) };
    });
}

/**
 * The transports map a stored row carries for a resolved instance: only the
 * protocols with an endpoint — a `{ baseUrl: null }` row would read as one.
 */
export const storedTransports = (instance) => Object.fromEntries(Object.entries(instance.transports)
  .filter(([, transport]) => isNonBlankStr(transport.baseUrl))
  .map(([protocol, transport]) => [protocol, { baseUrl: transport.baseUrl }]));

/** The models a plan may list, per the definition's own filter. Identity when it has none. */
export const applyServicePlanFilter = (definition, plan, models) => (
  typeof definition?.catalog?.planFilter === 'function' ? definition.catalog.planFilter(plan, models) : models
);

/**
 * Where the credential this instance runs under comes from, in
 * `credentialInventory`'s vocabulary and with its precedence — so a
 * subscription instance can report "signed in via CLI" without holding a key,
 * and a `bootstrap` one "supplied by the launch wrapper" (`config`). Never
 * the value itself.
 *
 * @param {{credentialVia?: string, credentials?: object}} connection
 * @param {{definition?: object|null, env?: Record<string, string|undefined>, envFile?: Map<string, string>|null}} [sources]
 */
export function credentialSourceFor(connection, { definition = null, env = {}, envFile = null } = {}) {
  const via = connection.credentialVia ?? 'stored';
  if (via === 'cli-login') return 'cli';
  if (via === 'bootstrap') return 'config';
  if (via === 'stored' && connectionHasCredentials(connection)) return 'settings';
  const names = definition?.credential?.envVars ?? [];
  const processKey = names.find((name) => isNonBlankStr(env[name]));
  const fileKey = names.find((name) => isNonBlankStr(envFile?.get?.(name)));
  if (processKey && fileKey && env[processKey] === envFile.get(fileKey)) return 'env-file';
  if (processKey) return 'env';
  return fileKey ? 'env-file' : 'none';
}

// --- the sanitized service DTO ---------------------------------------------------

const definitionDtoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  family: z.enum(SERVICE_FAMILIES),
  plans: z.array(z.enum(SERVICE_PLANS)).min(1),
  catalogStrategy: z.enum(CATALOG_STRATEGIES),
  harnessOnly: z.string().nullable(),
  // Where a key is obtained and which variables it is conventionally held
  // under — what a Services card's "get a key" link and env hint read (#7567).
  keyUrl: z.string().nullable(),
  envVars: z.array(z.string()),
  // The transports a definition speaks with their default base URLs, so an
  // "Add service" form can pre-fill an endpoint or demand one where the
  // definition declares none.
  transports: z.record(z.string(), z.object({ defaultBaseUrl: z.string().nullable() }).strict()),
}).strict();

/**
 * One definition as the wire publishes it — the `definition` half of the
 * service DTO and each row of `GET /api/providers/service-definitions`.
 * Code-only data: no instance, no credential.
 */
export const presentServiceDefinition = (definition) => ({
  id: definition.id,
  label: definition.label,
  family: definition.family,
  plans: [...definition.plans],
  catalogStrategy: definition.catalog.strategy,
  harnessOnly: definition.harnessOnly ?? null,
  keyUrl: definition.credential.keyUrl ?? null,
  envVars: [...definition.credential.envVars],
  transports: Object.fromEntries(Object.entries(definition.transports)
    .map(([protocol, transport]) => [protocol, { defaultBaseUrl: transport.defaultBaseUrl ?? null }])),
});

/**
 * One instance as `GET /api/providers/services` publishes it: the connection
 * DTO (so a column is mapped in exactly one place and `credentials` never
 * appears) plus what only the service reading adds. `.strict()` like every
 * graph DTO.
 */
export const serviceDtoSchema = connectionDtoSchema.extend({
  definition: definitionDtoSchema.nullable(),
  credentialSource: z.enum(CREDENTIAL_SOURCES),
  bindingCount: z.number().int().nonnegative(),
  // One word a card can act on. `unknown-definition` is a row nothing composes
  // onto (a kind this release has no definition for), not a broken one.
  readiness: z.enum(['ready', 'disabled', 'needs-endpoint', 'needs-credential', 'unknown-definition']),
}).strict();

function serviceReadiness(connection, definition, credentialSource) {
  if (!definition) return 'unknown-definition';
  if (!connection.enabled) return 'disabled';
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
 * @param {{bindingCount?: number, credentialSource?: string, definition?: object|null}} [context] —
 *   `definition` may be passed by a caller that already resolved it.
 */
export function toServiceDto(connection, { bindingCount = 0, credentialSource = 'none', definition } = {}) {
  const base = toConnectionDto(connection);
  const resolved = definition === undefined ? (base.definitionId ? serviceDefinitionById(base.definitionId) : null) : definition;
  return serviceDtoSchema.parse({
    ...base,
    definition: resolved ? presentServiceDefinition(resolved) : null,
    credentialSource,
    bindingCount,
    readiness: serviceReadiness(base, resolved, credentialSource),
  });
}
