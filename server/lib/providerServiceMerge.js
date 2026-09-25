import { isDeepStrictEqual } from 'node:util';
import { providerConnectionProfile } from './providerConnections.js';
import { isDerivedPreset, routeBelongsOnConnection } from './providerGraphRecords.js';
import { impliedCatalogNarrowing, listedModels, rederivePreset } from './providerPresets.js';
import { instanceApiKeyFor, instanceForConnection } from './providerServiceInstances.js';
import { SERVICE_DEFINITIONS, serviceDefinitionById } from './serviceDefinitions.js';

/**
 * Fold duplicate SERVICE INSTANCES into one (epic #7561, D2/D3).
 *
 * The graph import (#6366) gives every harness its own connection — sharing
 * across harnesses was an explicit link — so an install that ran `nvidia-nim`
 * (direct API) beside `opencode-nvidia-nim` (an OpenCode wrapper on the same
 * endpoint) ends up with two NVIDIA NIM services, one of them labelled after
 * the harness. Under the composed model a service is the backend alone and a
 * harness pointed at it is a PRESET, so both belong on one instance.
 *
 * This is the pure planner: which rows are one backend, which row keeps its
 * identity, and what the surviving row holds. Rows fold only on evidence that
 * they reach the SAME backend under the SAME terms:
 *
 *   - the same service definition — or a generic `openai-compatible` row whose
 *     endpoint is exactly a named definition's default (a direct API record on
 *     NVIDIA's URL is the NVIDIA NIM service, not "some OpenAI-compatible API");
 *   - at least one protocol both declare, at the same base URL, and no protocol
 *     declared at two different ones. "Both named nothing" is never a match, so
 *     a transport-less subscription row never folds;
 *   - the same enabled state and credential mode, no credential name holding two values, and
 *     never two different keys the instance would run under;
 *   - the same plan — two plans of one definition are two legitimate instances
 *     (D3). The one exception is a generic row whose plan the named definition
 *     does not even sell: that plan was a classification default, not a choice;
 *   - every LEGACY route on the folded row is still contained by the merged row
 *     (`routeBelongsOnConnection`), so the next reconcile pass keeps it there
 *     rather than cloning it straight back off. A DERIVED preset names its
 *     service by slug and is re-derived onto the survivor by the caller.
 *
 * A row with a route mid-projection, or a route whose record is gone, sits the
 * pass out: its values are exactly what is in dispute. A row NO harness is
 * bound to is never folded away — that is a service someone just created and
 * has not made a preset from yet, not an import's per-harness copy — though it
 * may survive a fold and absorb one.
 */

const GENERIC_DEFINITION_ID = 'openai-compatible';

/** Protocols whose URL a named definition ships as its default — what a generic row is recognized by. */
const DEFAULT_ENDPOINTS = SERVICE_DEFINITIONS.flatMap((definition) => Object.entries(definition.transports || {})
  .filter(([, transport]) => typeof transport?.defaultBaseUrl === 'string' && transport.defaultBaseUrl !== '')
  .map(([protocol, transport]) => ({ protocol, baseUrl: transport.defaultBaseUrl, definitionId: definition.id })));

/** The definition a row really is: its own, or the named one a generic row's endpoint belongs to. */
function effectiveDefinitionId(connection) {
  if (connection.definitionId !== GENERIC_DEFINITION_ID) return connection.definitionId;
  const match = DEFAULT_ENDPOINTS.find(({ protocol, baseUrl }) => connection.transports?.[protocol]?.baseUrl === baseUrl);
  return match?.definitionId ?? connection.definitionId;
}

/** Union two transport maps, or null when a protocol names two URLs or none is shared. */
function mergeTransports(a, b) {
  const shared = Object.keys(a).filter((protocol) => Object.hasOwn(b, protocol));
  if (shared.length === 0) return null;
  if (!shared.every((protocol) => a[protocol]?.baseUrl === b[protocol]?.baseUrl)) return null;
  return { ...b, ...a };
}

/** Union two credential maps, or null when one name holds two values. */
function mergeCredentials(a, b) {
  const shared = Object.keys(a).filter((name) => Object.hasOwn(b, name));
  if (!shared.every((name) => a[name] === b[name])) return null;
  return { ...b, ...a };
}

function mergeCatalogs(a, b) {
  const models = [...new Set([...(a?.models || []), ...(b?.models || [])])];
  const state = a?.state === 'known' || b?.state === 'known' ? 'known' : (a?.state ?? 'unknown');
  return { state, models };
}

/**
 * The row `candidate` and the accumulated `merged` row would become, or null
 * when they are not provably the same backend under the same terms.
 */
function foldInto(merged, candidate, definition) {
  if ((merged.credentialVia ?? 'stored') !== (candidate.credentialVia ?? 'stored')) return null;
  // A service switched off is a choice a fold must not undo (or impose).
  if ((merged.enabled !== false) !== (candidate.enabled !== false)) return null;
  const planForeign = candidate.definitionId !== merged.definitionId && !definition.plans.includes(candidate.plan);
  if (candidate.plan !== merged.plan && !planForeign) return null;
  const transports = mergeTransports(merged.transports || {}, candidate.transports || {});
  if (!transports) return null;
  const credentials = mergeCredentials(merged.credentials || {}, candidate.credentials || {});
  if (!credentials) return null;
  const keys = [merged, candidate].map((row) => instanceApiKeyFor(row, definition, {})).filter(Boolean);
  if (new Set(keys).size > 1) return null;
  return {
    ...merged,
    transports,
    credentials,
    catalog: mergeCatalogs(merged.catalog, candidate.catalog),
  };
}

/**
 * Plan every fold the graph admits.
 *
 * @param {{connections: object[], bindings: object[], routes: object[]}} graph
 * @param {object[]} providers - the executable records the routes name
 * @param {{bootstraps?: Record<string, object>, env?: Record<string, string|undefined>}} [context]
 *   the configured bootstrap apps and the environment a derived preset resolves against
 * @returns {{keeper: object, absorbedIds: string[], absorbedSlugs: string[],
 *            bindingMoves: {bindingId: string, variantKey: string}[], presetPatches: Record<string, object>}[]}
 *   `keeper` is the surviving row as it should be stored (its id, kind, slug
 *   and definition unchanged); `presetPatches` the `providers.json` writes
 *   that re-point every derived preset on it ({@link presetPatchesForMerge}).
 */
export function planServiceInstanceMerges(graph, providers, { bootstraps = {}, env = process.env } = {}) {
  const records = new Map((Array.isArray(providers) ? providers : [])
    .filter((record) => record && typeof record === 'object' && record.id)
    .map((record) => [record.id, record]));
  const groups = new Map();
  for (const connection of graph.connections) {
    if (!connection.slug || !connection.definitionId || Object.keys(connection.transports || {}).length === 0) continue;
    const bindings = graph.bindings.filter((binding) => binding.connectionId === connection.id);
    const bindingIds = new Set(bindings.map((binding) => binding.id));
    const routes = graph.routes.filter((route) => bindingIds.has(route.bindingId));
    if (routes.some((route) => route.pending || !records.has(route.providerId))) continue;
    const definition = serviceDefinitionById(effectiveDefinitionId(connection));
    if (!definition) continue;
    const group = groups.get(definition.id) || { definition, members: [] };
    group.members.push({ connection, bindings, routes });
    groups.set(definition.id, group);
  }

  const merges = [];
  for (const { definition, members } of groups.values()) {
    if (members.length < 2) continue;
    const definitionId = definition.id;
    // The survivor keeps its id, kind and slug, so prefer the row that already
    // IS the named definition, then the one addressed by the definition's own
    // id, then the one labelled as the service; ties keep table order.
    const rank = ({ connection }) => (connection.definitionId === definitionId ? 0 : 4)
      + (connection.slug === definitionId ? 0 : 2)
      + (connection.label === definition.label ? 0 : 1);
    const remaining = [...members].sort((a, b) => rank(a) - rank(b));
    while (remaining.length > 1) {
      const lead = remaining.shift();
      let merged = { ...lead.connection };
      let presetPatches = {};
      const absorbed = [];
      for (const member of [...remaining]) {
        if (member.bindings.length === 0) continue;
        const next = foldInto(merged, member.connection, definition);
        if (!next) continue;
        const legacy = member.routes.filter((route) => !isDerivedPreset(records.get(route.providerId)));
        if (!legacy.every((route) => routeBelongsOnConnection(providerConnectionProfile(records.get(route.providerId)), next))) continue;
        // The label is settled below; nothing a preset derives reads it.
        const onRow = [lead, ...absorbed, member].flatMap(({ routes }) => routes).map((route) => records.get(route.providerId));
        const patches = presetPatchesForMerge(next, onRow, bootstraps, env);
        if (!patches) continue;
        merged = next;
        presetPatches = patches;
        absorbed.push(member);
        remaining.splice(remaining.indexOf(member), 1);
      }
      if (absorbed.length === 0) continue;
      merged.label = serviceLabel([lead, ...absorbed], definition);
      merges.push({ ...planMoves(lead, absorbed), keeper: merged, presetPatches });
    }
  }
  return merges;
}

/**
 * The survivor's label. An import names each row after the record it came
 * from, so every row but a direct API one carries its harness ("OpenCode NVIDIA
 * NIM") — wrong once the row serves several. Prefer a member already named as
 * the service, then a direct-API member's name, then the definition's own.
 */
function serviceLabel(members, definition) {
  if (members.some(({ connection }) => connection.label === definition.label)) return definition.label;
  const direct = members.find(({ bindings }) => bindings.some((binding) => binding.harnessId == null));
  return direct?.connection.label || definition.label;
}

/** Binding moves onto the survivor, each on a variant key free on it: `UNIQUE(connection, harness, variant)`. */
function planMoves(lead, absorbed) {
  const key = (harnessId, variantKey) => JSON.stringify([harnessId ?? null, variantKey]);
  const taken = new Set(lead.bindings.map((binding) => key(binding.harnessId, binding.variantKey)));
  const bindingMoves = [];
  for (const { bindings } of absorbed) {
    for (const binding of bindings) {
      const variantKey = taken.has(key(binding.harnessId, binding.variantKey)) ? `variant:${binding.id}` : binding.variantKey;
      taken.add(key(binding.harnessId, variantKey));
      bindingMoves.push({ bindingId: binding.id, variantKey });
    }
  }
  return {
    absorbedIds: absorbed.map(({ connection }) => connection.id),
    absorbedSlugs: absorbed.map(({ connection }) => connection.slug),
    bindingMoves,
  };
}

/**
 * The `providers.json` patches that put every DERIVED preset among `records`
 * on the fold's survivor: its `serviceId` becomes the survivor's slug and
 * everything the service owns is re-derived from the merged row. A preset keeps
 * the model list it was running with — the survivor's catalog is the union of
 * the folded rows', so a preset with no narrowing of its own is narrowed to its
 * current list whenever that list is still all listed (the same rule the
 * conversion backfill applies).
 *
 * `null` when any preset cannot be derived there unchanged (an unknown
 * harness, a deleted bootstrap app, a refused composition, a model list the
 * survivor's plan would cut): the planner then leaves that row out of the fold
 * rather than splitting a service's presets.
 *
 * @param {object} keeper - the survivor as `planServiceInstanceMerges` returned it
 * @param {object[]} records - the executable records on it (legacy ones are skipped)
 * @param {Record<string, object>} bootstraps - the configured bootstrap apps
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, object>|null}
 */
function presetPatchesForMerge(keeper, records, bootstraps, env) {
  const derived = records.filter(isDerivedPreset);
  if (derived.length === 0) return {};
  const instance = instanceForConnection(keeper, env);
  if (!instance) return null;
  const listed = listedModels(instance, keeper.catalog);
  const patches = {};
  for (const record of derived) {
    const next = { ...record, serviceId: keeper.slug };
    const narrowing = Array.isArray(record.catalogNarrowing) ? null : impliedCatalogNarrowing(record, listed);
    if (narrowing) next.catalogNarrowing = narrowing;
    const result = rederivePreset(next, { instance, catalog: keeper.catalog, bootstraps, stored: record });
    // A fold must not change what a preset runs: a list the survivor's plan
    // would cut (a paid-model preset onto a free-plan instance) refuses it.
    if (!result || !isDeepStrictEqual(result.derived.models, Array.isArray(record.models) ? record.models : [])) return null;
    if (Object.keys(result.patch).length > 0) patches[record.id] = result.patch;
  }
  return patches;
}
