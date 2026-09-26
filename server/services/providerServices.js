import { randomUUID } from 'node:crypto';
import { ServerError } from '../lib/errorHandler.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { nextConnectionCatalog, sanitizeCatalogError } from '../lib/providerGraphRecords.js';
import {
  allocateServiceSlug,
  applyServicePlanFilter,
  credentialSourceFor,
  instanceApiKeyFor,
  kindForDefinition,
  storedTransports,
  takenServiceSlugs,
  toServiceDto,
} from '../lib/providerServiceInstances.js';
import { requireToolkit } from '../lib/aiToolkitState.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { resolveServiceInstance, serviceDefinitionById } from '../lib/serviceDefinitions.js';
import {
  connectionFanout,
  findConnectionByRef,
  rematerializeDerivedPresets,
  requireProviderGraph,
  serializeProviderGraph,
  updateConnectionSettings,
} from './providerGraph.js';
import { readGraph, saveConnectionSettings, writeGraph } from './providerGraphStore.js';

/**
 * Service INSTANCES over the provider connection graph (#7563, epic #7561).
 *
 * An `ai_connections` row is one instance of a `SERVICE_DEFINITIONS` row: a
 * slug it is addressed by, the plan the user declared, how it authenticates,
 * and the catalog it last listed. This module is the management surface for
 * that reading of the row — list, create from a definition, refresh the catalog
 * through the DEFINITION's listing strategy — while the row itself stays the
 * connection every existing graph operation already handles. Edits and deletes
 * go through `providerGraph.js` unchanged, addressed by slug.
 *
 * Every mutation runs on the graph's serialization queue. **No provider is
 * contacted except by the explicit refresh** (AGENTS.md "No cold-bootstrap LLM
 * calls"): listing and creating are local I/O only.
 */

/** Hosted APIs answer `/models` slower than a loopback daemon; the probe default is tuned for the latter. */
const CATALOG_PROBE_TIMEOUT_MS = 10_000;
const ANTHROPIC_VERSION = '2023-06-01';

// Deferred: `credentialInventory.js` is otherwise unreachable from the
// providers route tree, and every suite that reaches the tree would pay its
// closure for a file read only when a service is described (server/AGENTS.md
// "Import scoping").
const loadInstallEnvFile = async () => (await import('./credentialInventory.js')).loadInstallEnvFile();

/**
 * GET `/models` on the instance's own endpoint with its own key.
 *
 * Serves both `probe` (a hosted API) and `daemon` (a local runtime): the
 * runtime managers list the INSTALL's configured daemon, not the row's
 * endpoint, and an instance pointed at a second daemon would be answered for
 * by the first. The row names where it is; that is what gets asked.
 *
 * `reachable: true, models: null` (an unreadable listing, or a 401) is a
 * FAILED refresh, never an empty one — the three-state probe is what lets
 * "answered nothing" and "could not answer" stay apart.
 */
async function listByProbe(connection, definition, { env, probe }) {
  const apiKey = instanceApiKeyFor(connection, definition, env);
  const openai = connection.transports?.openai?.baseUrl;
  const anthropic = connection.transports?.anthropic?.baseUrl;
  if (!openai && !anthropic) return { refreshed: false, error: 'This service declares no endpoint to list models from' };

  const result = openai
    ? await probe(openai, { apiKey, timeoutMs: CATALOG_PROBE_TIMEOUT_MS })
    // The Anthropic API lists at `/v1/models` under its own header pair.
    : await probe(`${anthropic.replace(/\/+$/, '')}/v1`, {
      timeoutMs: CATALOG_PROBE_TIMEOUT_MS,
      headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': ANTHROPIC_VERSION },
    });
  if (!Array.isArray(result.models)) return { refreshed: false, error: result.error || 'The model listing was not readable' };
  return { refreshed: true, models: result.models, contextWindows: result.contextWindows };
}

/**
 * Ask the program that signs in. `ok: false` — an uninstalled binary, a
 * signed-out CLI, a refused probe — is a failure with its reason, never an
 * empty catalog: `refreshHarnessModels` already refuses to report a blank
 * listing as "zero models", and this keeps that refusal.
 *
 * Codex now has its own lister (`listModels`, driving `codex app-server`'s
 * JSON-RPC handshake — `services/harnesses.js`, #8497) and no longer needs
 * this fallback. But it is NOT the only harness `refreshHarnessModels` refuses
 * with `noLister`: Claude Code (`claude-subscription`) still has neither
 * `modelsArgs` nor a `listModels` hook — its catalog is read from a per-record
 * on-disk cache the toolkit already knows how to fetch through a BOUND route
 * (`fetchProviderModels` → `_fetchAnthropicModels`), never from the harness
 * binary directly. Dropping the fallback entirely would make
 * `claude-subscription`'s catalog refresh fail outright even though a working
 * route sits right there, so a harness that refuses with `noLister` still
 * falls back to a bound route's own lister — that catalog can still update.
 * Any other refusal (not installed, signed out, empty probe) stays a refusal.
 */
async function listByHarness(connection, definition, graph, { harnessModels, routeModels }) {
  const result = await harnessModels(definition.harnessOnly);
  if (result?.ok) return { refreshed: true, models: result.models || [] };
  for (const route of result?.noLister ? connectionFanout(graph, connection.id).routes : []) {
    const models = await routeModels(route.providerId).catch(() => null);
    if (Array.isArray(models) && models.length > 0) return { refreshed: true, models };
  }
  return { refreshed: false, error: result?.reason || `${definition.label} could not list its models` };
}

/**
 * One strategy dispatch, as `definition.catalog.strategy` names it. `static`
 * has nothing to ask: the instance's declared list IS the catalog, re-stamped
 * as known.
 */
async function listByStrategy(connection, definition, graph, deps) {
  switch (definition.catalog.strategy) {
    case 'probe':
    case 'daemon':
      return listByProbe(connection, definition, deps);
    case 'harness':
      return listByHarness(connection, definition, graph, deps);
    case 'static':
      return { refreshed: true, models: connection.catalog?.models || [] };
    default:
      return { refreshed: false, error: `Unknown catalog strategy "${definition.catalog.strategy}"` };
  }
}

const defaultDeps = () => ({
  env: process.env,
  probe: probeOpenAiModels,
  // The harness registry names programs by harness id (`antigravity`,
  // `cursor`); the runtime table lists them by binary (`agy`, `cursor-agent`)
  // with the harness id as its `vendor`. Resolve through the vendor so every
  // harness-only definition reaches its lister.
  harnessModels: async (harnessId) => {
    const [{ refreshHarnessModels }, { PROVIDER_RUNTIMES }] = await Promise.all([import('./harnesses.js'), import('./providerRuntimeInstaller.js')]);
    const runtime = PROVIDER_RUNTIMES.find((row) => row.vendor === harnessId || row.id === harnessId)?.id ?? harnessId;
    return refreshHarnessModels(runtime);
  },
  // Probe-only: the answer lands in the instance catalog, never on the record.
  routeModels: (providerId) => requireToolkit().services.providers.fetchProviderModels(providerId),
  now: () => new Date().toISOString(),
});

function requireService(graph, ref) {
  const connection = findConnectionByRef(graph, ref);
  if (!connection) throw new ServerError('Service not found', { status: 404, code: 'SERVICE_NOT_FOUND' });
  return connection;
}

/** The sanitized DTO for one row, with the derived fields the list also carries. */
function describe(connection, graph, envFile) {
  const definition = connection.definitionId ? serviceDefinitionById(connection.definitionId) : null;
  return toServiceDto(connection, {
    definition,
    bindingCount: graph.bindings.filter((binding) => binding.connectionId === connection.id).length,
    credentialSource: credentialSourceFor(connection, { definition, env: process.env, envFile }),
  });
}

/**
 * Every instance, sanitized: never a credential value, never a projection
 * snapshot. A caller holding a fresh graph read passes it to skip a second.
 */
export async function listServices({ graph: preread = null } = {}) {
  requireProviderGraph();
  const [graph, envFile] = await Promise.all([preread ?? readGraph(), loadInstallEnvFile()]);
  return { services: graph.connections.map((connection) => describe(connection, graph, envFile)) };
}

/** One instance by slug or UUID, sanitized like the list. */
export async function getService(ref) {
  requireProviderGraph();
  const [graph, envFile] = await Promise.all([readGraph(), loadInstallEnvFile()]);
  return { service: describe(requireService(graph, ref), graph, envFile) };
}

/**
 * Create an instance FROM a definition — the counterpart of
 * `createConnection`, which takes a bare kind and transports.
 *
 * The definition decides what is legal (`resolveServiceInstance`: a known
 * definition, a plan it sells, transports it speaks — each a typed 400), and
 * the row is stored with the `kind` reconciliation derives for that
 * definition's records, so the next pass judges it exactly as an imported
 * route would be. A `bootstrap` instance stores no secret whatever was sent:
 * the launch wrapper supplies it.
 *
 * Nothing is probed. The catalog starts `unknown`; discovery is the explicit
 * `POST /services/:slug/refresh-catalog`.
 */
export function createService({
  definitionId, slug, label, plan, enabled = true, transports = {}, credentials = {}, credentialVia = 'stored',
}) {
  return serializeProviderGraph(async () => {
    requireProviderGraph();
    const [graph, envFile] = await Promise.all([readGraph(), loadInstallEnvFile()]);
    const taken = takenServiceSlugs(graph.connections);
    if (slug && taken.has(slug)) {
      throw new ServerError(`A service is already addressed as "${slug}"`, { status: 409, code: 'SERVICE_SLUG_TAKEN' });
    }
    const instance = resolveServiceInstance({
      definitionId, slug: slug ?? allocateServiceSlug(definitionId, taken), plan, transports, credentials, credentialVia,
    });
    const { definition } = instance;

    const connection = {
      id: randomUUID(),
      revision: 1,
      kind: kindForDefinition(definition),
      label: label ?? definition.label,
      transports: storedTransports(instance),
      credentials: credentialVia === 'bootstrap' ? {} : credentials,
      catalog: { state: 'unknown', models: [] },
      slug: instance.slug,
      definitionId: definition.id,
      plan: instance.plan,
      enabled,
      credentialVia,
    };
    await writeGraph({ connections: [connection], bindings: [], routes: [] });
    console.log(`🔗 Created service instance ${connection.slug} (${definition.id}, plan ${connection.plan})`);
    return { service: describe(connection, graph, envFile) };
  });
}

/**
 * Edit an instance: the shared-backend edit (`updateConnectionSettings`, which
 * owns the availability guard, the revision gate, the credential merge and the
 * route projection) plus plan / enabled / credential mode, then the row read
 * back as a DTO.
 *
 * Not wrapped in a second `serialize`: the inner call already runs on the
 * queue, and queueing behind it from inside would wait on itself.
 */
export async function updateService(ref, input) {
  await updateConnectionSettings({ connectionId: ref, ...input });
  return getService(ref);
}

/**
 * Refresh one instance's catalog through its DEFINITION's listing strategy —
 * the whole point of the instance owning its catalog: it no longer needs an
 * executable route to have something to probe.
 *
 * The plan filter runs before the catalog rule, so two instances of one
 * definition under different plans list different models from one answer
 * (OpenCode Zen `free` keeps only `*-free`). Then `nextConnectionCatalog`'s
 * contract holds unchanged: a failure keeps what was known with a sanitized
 * reason, a successful empty answer is `known` and empty. No pin, default or
 * route model list is touched.
 */
export function refreshServiceCatalog(ref, deps = {}) {
  const { env, probe, harnessModels, routeModels, now } = { ...defaultDeps(), ...deps };
  return serializeProviderGraph(async () => {
    requireProviderGraph();
    const [graph, envFile] = await Promise.all([readGraph(), loadInstallEnvFile()]);
    const connection = requireService(graph, ref);
    const definition = connection.definitionId ? serviceDefinitionById(connection.definitionId) : null;
    if (!definition) {
      throw new ServerError('This service has no definition to list models through; use the connection refresh',
        { status: 409, code: 'SERVICE_DEFINITION_UNKNOWN' });
    }

    const outcome = await listByStrategy(connection, definition, graph, { env, probe, harnessModels, routeModels })
      .catch((err) => ({ refreshed: false, error: err }));
    const catalog = nextConnectionCatalog(connection.catalog, {
      ...outcome,
      models: outcome.refreshed ? applyServicePlanFilter(definition, connection.plan, outcome.models || []) : undefined,
      error: outcome.error == null ? null : sanitizeCatalogError(outcome.error, connection.credentials),
    }, { now });
    const revision = await saveConnectionSettings({ ...connection, catalog });
    // A derived preset's `models` is this catalog narrowed (#7565): a listing
    // that changed reaches every preset on the instance in the same request.
    await rematerializeDerivedPresets({ ...connection, catalog, revision: revision ?? connection.revision });

    console.log(`🔗 Refreshed service ${connection.slug ?? connection.id} catalog via ${definition.catalog.strategy}: `
      + `${catalog.state}, ${catalog.models.length} models`);
    return { service: describe({ ...connection, catalog, revision: revision ?? connection.revision }, graph, envFile) };
  });
}
