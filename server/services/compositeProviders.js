import { parseProviderRef } from '../lib/providerRef.js';
import { PROVIDER_HARNESSES, harnessById, isCompatible } from '../lib/providerHarnesses.js';
import { materializeRouteOutcome } from '../lib/providerRouteRecipes.js';
import { bootstrapInputFor } from '../lib/providerPresets.js';
import { applyServicePlanFilter, instanceForConnection } from '../lib/providerServiceInstances.js';
import { effortLevelsForProvider } from '../lib/providerModels.js';
import { listCredentialBootstraps, presentCredentialBootstraps } from './credentialBootstrapApps.js';
import { harnessEnablementFrom, harnessSettingsRevision, listHarnessEnablement } from './harnessEnablement.js';
import { findConnectionByRef, providerGraphEnabled } from './providerGraph.js';
import { readGraph } from './providerGraphStore.js';
import { listServices } from './providerServices.js';
import { peekProviderRuntimeStatuses } from './providerRuntimeInstaller.js';
import { getSettings } from './settings.js';
import { createSingleFlight } from '../lib/singleFlight.js';

/**
 * COMPOSITE provider resolution (#7564, epic #7561): turning a
 * `<harness>.<method>@<service-slug>[+<bootstrap-slug>]` id into the executable
 * record every run path already consumes — through the same seam it resolves a
 * preset id today (`getProviderById`), so `{ providerId, model, effort }`
 * selections keep their shape.
 *
 * A composite is materialized on every resolve from three live inputs and is
 * NEVER persisted: the harness registry (code), the service instance (an
 * `ai_connections` row addressed by slug) and settings (harness enablement,
 * bootstrap apps). Disabling the harness or the service makes it ineligible;
 * re-enabling restores it, with nothing to migrate.
 *
 * Every refusal has a reason (`describeCompositeProvider`), so a saved
 * selection that names an ineligible composite stays VISIBLE with its reason
 * rather than being substituted — never a silent swap onto another provider.
 *
 * The credential rides the record exactly as a preset's does: a `field`
 * credential is attached NON-enumerably (the `attachGatewaySiblingKey`
 * discipline, so a spread/JSON round-trip drops it), and an env-borne one
 * sits in `envVars` under a name listed in `secretEnvVars`, which every
 * client-facing sanitizer redacts. The record's `id` is the composite itself,
 * so a status/readiness lookup keyed on it answers for the composition.
 *
 * Settings-only and local I/O only: nothing here probes a binary or contacts a
 * provider (AGENTS.md "No cold-bootstrap LLM calls").
 */

/**
 * Short TTL on the graph read. The hot path is an N-way failure storm — each
 * failing run re-resolves its provider — and a composite lookup would otherwise
 * be three SELECTs each time. Human-paced edits to a service arrive on the next
 * tick; the materialized record itself is keyed on the row's revision below.
 */
const GRAPH_SNAPSHOT_TTL_MS = 1000;
let graphSnapshot = null;
let graphSnapshotAt = -Infinity;
// One read per cold window even when N callers miss it together.
const graphReads = createSingleFlight();

/**
 * id → { key, outcome } — one entry per composite, replaced when its inputs
 * move. The key is the graph snapshot's timestamp plus the settings revision:
 * a service edit lands on the next snapshot, a settings save bumps the
 * revision, and a warm hit costs no I/O at all.
 */
const materialized = new Map();

/** Drop every cached derivation. Exported for tests and for a caller that just changed a service row. */
export function invalidateCompositeCache() {
  graphSnapshot = null;
  graphSnapshotAt = -Infinity;
  materialized.clear();
}

async function graphWithinTtl() {
  if (graphSnapshot && Date.now() - graphSnapshotAt < GRAPH_SNAPSHOT_TTL_MS) return graphSnapshot;
  return graphReads.run('graph', async () => {
    graphSnapshot = await readGraph();
    graphSnapshotAt = Date.now();
    return graphSnapshot;
  });
}

/**
 * The parts a (harness, method, service, bootstrap) tuple names, or the reason
 * one of them does not resolve — shared by the composite resolver and the
 * preset save (#7565), so both refuse the same input with the same code.
 * Enablement is NOT checked here: a stored preset on a switched-off harness is
 * still editable, while a composite on one is not runnable.
 *
 * @returns {{harness: object, connection: object, instance: object, bootstrap: object|null, code: null, reason: null}
 *   | {harness: null, connection: null, instance: null, bootstrap: null, code: string, reason: string}}
 */
export function resolveCompositeParts({ harnessId, method, serviceSlug, bootstrapSlug = null }, { graph, bootstraps, env = process.env }) {
  const refuse = (code, reason) => ({ harness: null, connection: null, instance: null, bootstrap: null, code, reason });
  const harness = harnessById(harnessId);
  if (!harness) return refuse('harness-unknown', `No harness "${harnessId}"`);
  if (!harness.modes.includes(method)) return refuse('method-unsupported', `${harness.label} has no ${method} mode`);
  const connection = findConnectionByRef(graph, serviceSlug);
  if (!connection || connection.slug !== serviceSlug) return refuse('service-unknown', `No service is addressed as "${serviceSlug}"`);
  const instance = instanceForConnection(connection, env);
  if (!instance) return refuse('service-undefined', `Service "${serviceSlug}" has no definition this build composes onto`);
  let bootstrap = null;
  if (bootstrapSlug) {
    const app = bootstraps?.[bootstrapSlug];
    if (!app) return refuse('bootstrap-unknown', `No credential bootstrap app is addressed as "${bootstrapSlug}"`);
    bootstrap = bootstrapInputFor(bootstrapSlug, app);
  }
  return { harness, connection, instance, bootstrap, code: null, reason: null };
}

/**
 * Resolve, with the reason for a refusal. Pure over its inputs so the tests
 * pin the policy without a store: the graph, the settings and the bootstrap
 * table arrive as data.
 *
 * @param {string} id
 * @param {{graph: {connections: object[]}, settings: object, bootstraps: object, runtimes?: object, env?: object}} inputs
 * @returns {{record: object|null, code: string|null, reason: string|null, parts: object|null}}
 */
export function materializeComposite(id, { graph, settings, bootstraps, runtimes = undefined, env = process.env }) {
  const ref = parseProviderRef(id);
  if (ref?.kind !== 'composite') return { record: null, code: 'not-composite', reason: `"${id}" is not a composite provider id`, parts: null };
  const parts = { harnessId: ref.harnessId, method: ref.method, serviceSlug: ref.serviceSlug, bootstrapSlug: ref.bootstrapSlug };
  const refuse = (code, reason) => ({ record: null, code, reason, parts });

  const harness = harnessById(ref.harnessId);
  if (!harness) return refuse('harness-unknown', `No harness "${ref.harnessId}"`);
  const enablement = harnessEnablementFrom(ref.harnessId, { settings, runtimes });
  if (!enablement?.enabled) {
    return refuse('harness-disabled', `${harness.label} is ${enablement?.source === 'setting' ? 'switched off' : 'not detected on this machine'}`);
  }
  const resolved = resolveCompositeParts(parts, { graph, bootstraps, env });
  if (resolved.code) return refuse(resolved.code, resolved.reason);
  const { connection, instance, bootstrap } = resolved;
  if (connection.enabled === false) return refuse('service-disabled', `Service "${ref.serviceSlug}" is switched off`);
  if (!isCompatible(harness, instance)) return refuse('incompatible', `${harness.label} cannot be pointed at ${instance.definition.label}`);

  const models = applyServicePlanFilter(instance.definition, instance.plan, connection.catalog?.models || []);
  const { record, error } = materializeRouteOutcome({
    harness,
    method: ref.method,
    serviceInstance: instance,
    bootstrap,
    providerId: id,
    name: `${harness.label} · ${connection.label || instance.definition.label}`,
    // No model pin unless the selection pairs one; the catalog's first entry
    // is the default a run with no model gets — mirroring a record with no
    // `defaultModel`, whose runs take the first of `models` today.
    selection: { model: models[0] ?? null },
    overrides: { models: [...models] },
  });
  // A refusal is a REASON on this composite, not a failure of the lookup: the
  // caller asked "is this runnable?", and "no, because…" is the answer.
  if (error) return refuse(error.code, error.message);
  return { record: withHiddenCredential(record), code: null, reason: null, parts };
}

/**
 * Move a `field` credential off the enumerable surface. Same discipline as
 * `attachGatewaySiblingKey`: a spread or JSON round-trip drops it, and every
 * caller that clones a record for execution already re-carries it.
 */
function withHiddenCredential(record) {
  if (!Object.hasOwn(record, 'apiKey')) return record;
  const { apiKey, ...rest } = record;
  if (apiKey) Object.defineProperty(rest, 'apiKey', { value: apiKey, enumerable: false, configurable: true });
  return rest;
}

/**
 * The full verdict for a composite id, from live inputs. `eligible: false`
 * carries the code and reason a picker shows beside a saved selection.
 *
 * @param {string} id
 * @returns {Promise<{id: string, eligible: boolean, code: string|null, reason: string|null, parts: object|null, record: object|null}>}
 */
export async function describeCompositeProvider(id) {
  const ref = parseProviderRef(id);
  if (ref?.kind !== 'composite') {
    return { id, eligible: false, code: 'not-composite', reason: `"${id}" is not a composite provider id`, parts: null, record: null };
  }
  if (!providerGraphEnabled()) {
    return { id, eligible: false, code: 'graph-unavailable', reason: 'Service instances are unavailable on this install', parts: null, record: null };
  }
  const graph = await graphWithinTtl();
  const key = `${graphSnapshotAt}|${harnessSettingsRevision()}`;
  const cached = materialized.get(id);
  if (cached && cached.key === key) return { id, ...cached.outcome };
  const [settings, bootstraps] = await Promise.all([getSettings(), listCredentialBootstraps()]);
  const { record, code, reason, parts } = materializeComposite(id, { graph, settings, bootstraps, runtimes: peekProviderRuntimeStatuses() });
  const outcome = { eligible: record !== null, code, reason, parts, record };
  materialized.set(id, { key, outcome });
  return { id, ...outcome };
}

/**
 * The host resolver the toolkit calls from `getProviderById` for a composite
 * id (`createProviderService({ resolveCompositeProvider })`). `null` for
 * anything that is not runnable right now — the toolkit then answers exactly
 * as it does for an unknown preset id, and the caller's existing "provider not
 * found / using active provider" path names it.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function resolveCompositeProvider(id) {
  return (await describeCompositeProvider(id)).record;
}

/**
 * A providers map with every composite among `ids` materialized into it, for
 * the toolkit's `getFallbackProvider` — which reads its candidates off the map
 * and applies the caller's `allowedModes` to each. So a composite is admitted
 * as a fallback under exactly the mode policy every stored candidate meets
 * (#6368), and never otherwise.
 *
 * @param {Record<string, object>} providersMap — mutated and returned
 * @param {Array<string|null|undefined>} ids
 */
export async function withCompositeCandidates(providersMap, ids) {
  for (const id of ids) {
    if (typeof id !== 'string' || providersMap[id] || parseProviderRef(id)?.kind !== 'composite') continue;
    const record = await resolveCompositeProvider(id);
    if (record) providersMap[id] = record;
  }
  return providersMap;
}

/**
 * The ladder a harness accepts, read through the same function every route uses.
 * `models` is the catalog the ladder is narrowed against: Antigravity publishes
 * one entry per rung (`<base>-low|medium|high`), so `effortLevelsForProvider`
 * needs the surrounding catalog to tell which rungs a model actually offers.
 * Omitting it collapsed every per-model ladder onto the harness default.
 */
const harnessEffortLevels = (harness, model = null, models = []) => effortLevelsForProvider(
  { harnessId: harness.id, command: harness.recipe?.command ?? null, type: harness.modes[0], models },
  model,
);

/**
 * The composition catalog (`GET /api/providers/catalog`): every axis a picker
 * composes over, derived from cache and settings only — harness detection is
 * the runtime probe's cache, services are the graph rows, presets are the
 * stored records the caller hands in already sanitized.
 *
 * @param {{presets?: object[]}} [input]
 */
export async function buildProviderCatalog({ presets = [] } = {}) {
  const graphEnabled = providerGraphEnabled();
  const graph = graphEnabled ? await graphWithinTtl() : { connections: [] };
  const [harnesses, bootstraps, services] = await Promise.all([
    listHarnessEnablement(),
    listCredentialBootstraps(),
    graphEnabled ? listServices({ graph }).then((result) => result.services) : [],
  ]);
  const instances = graph.connections.map((connection) => ({ connection, instance: instanceForConnection(connection) }))
    .filter(({ instance }) => instance !== null);

  // One compatibility pass, read by both the slug map and the per-model ladders.
  const compatible = new Map(PROVIDER_HARNESSES.map((harness) => [harness.id, instances.filter(({ instance }) => isCompatible(harness, instance))]));
  const compatibility = Object.fromEntries([...compatible].map(([harnessId, rows]) => [harnessId, rows.map(({ instance }) => instance.slug)]));
  const effortLevels = Object.fromEntries(PROVIDER_HARNESSES.map((harness) => [harness.id, harnessEffortLevels(harness)]));
  const sameLadder = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((rung, i) => rung === b[i]));
  // Per-model ladders, only where a model narrows or widens the harness's own
  // (Codex's Ultra-capable models, Antigravity's per-model rungs): every
  // catalog model of a compatible service, keyed under the harness.
  const effortLevelsByModel = Object.fromEntries(PROVIDER_HARNESSES.map((harness) => {
    const base = effortLevels[harness.id];
    const models = new Set(compatible.get(harness.id)
      .flatMap(({ connection, instance }) => applyServicePlanFilter(instance.definition, instance.plan, connection.catalog?.models || [])));
    const catalogModels = [...models];
    const perModel = catalogModels
      .map((model) => [model, harnessEffortLevels(harness, model, catalogModels)])
      .filter(([, ladder]) => !sameLadder(ladder, base));
    return [harness.id, Object.fromEntries(perModel)];
  }));

  return {
    harnesses,
    services,
    bootstraps: presentCredentialBootstraps(bootstraps),
    compatibility,
    effortLevels,
    effortLevelsByModel,
    presets,
  };
}
