import { isDeepStrictEqual } from 'node:util';
import { isDerivedPreset } from './providerGraphRecords.js';
import { providerConnectionProfile, withoutConnectionOwnedFields } from './providerConnections.js';
import { harnessById, harnessForProvider } from './providerHarnesses.js';
import { parseOpencodeConfigContent } from './providerModels.js';
import { BACKEND_MARKER_KEYS, materializeRouteOutcome } from './providerRouteRecipes.js';
import { applyServicePlanFilter, instanceForConnection } from './providerServiceInstances.js';

/**
 * PRESETS (#7565, epic #7561): a stored `data/providers.json` record read as a
 * named (harness, method, service) tuple plus the user's own selection
 * defaults and overrides.
 *
 * A record carrying all three structural keys — `harnessId`, `method`,
 * `serviceId` — is a DERIVED preset: on every save its connection-owned
 * values (the program, the endpoint, the credential, the backend markers, the
 * inline bootstrap, the catalog) are re-materialized from the service instance
 * through `materializeRoute`, the same writer a composite id resolves through.
 * A record without them is a LEGACY preset: fully hand-editable, executed
 * exactly as before, and convertible only when re-deriving it reproduces what
 * it already carries ({@link derivedPresetDrift}).
 *
 * `data/providers.json` stays the fully materialized execution contract: an
 * older release runs a derived preset with no graph at all, because every
 * derived value is written into the record, and the structural keys are
 * additive and ignored by a schema that never saw them.
 *
 * Pure: no I/O, no clock, no spawn. Every input — the record, the harness row,
 * the resolved service instance, the instance's catalog, the bootstrap app —
 * arrives as data, so the merge rules are pinned without a store.
 */

/** The additive keys that make a record a derived preset (plus its two per-preset choices). */
export const PRESET_STRUCTURAL_KEYS = Object.freeze(['harnessId', 'method', 'serviceId', 'catalogNarrowing', 'credentialBootstrapId']);

/**
 * The record keys the SERVICE owns on a derived preset — written by
 * materialization, refused as a direct edit (`refusedDerivedEdits`). `envVars`
 * is owned per NAME, not as a whole: the transport and credential variables
 * the service writes are its own, while a harness-behaviour variable beside
 * them (`ANTHROPIC_SMALL_FAST_MODEL`) stays the preset's.
 */
export const DERIVED_PRESET_OWNED_KEYS = Object.freeze(['type', 'command', 'endpoint', 'apiKey', 'secretEnvVars', 'credentialBootstrap', ...BACKEND_MARKER_KEYS]);

/** `derived` when the three structural keys are set, else `legacy`. */
export const presetKind = (record) => (isDerivedPreset(record) ? 'derived' : 'legacy');

/**
 * Whether a LEGACY preset is a candidate for conversion: a harness this build
 * knows, spawned by the recipe's own binary (a path-configured `command` is a
 * deliberate choice materialization would overwrite), and a connection profile
 * with no isolation reason. The conversion itself still has to prove the
 * fixpoint against the service — this is the editor's "offer the button" test.
 */
/**
 * Whether the record spawns the recipe's own binary. A path-configured
 * `command` is a deliberate choice materialization would overwrite, so it
 * keeps a record legacy; a harness with no recipe (`direct`) has nothing to check.
 */
const spawnsRecipeBinary = (record, harness) => !harness.recipe || harness.recipe.command === record.command;

export function presetDerivable(record) {
  if (!record || typeof record !== 'object' || isDerivedPreset(record)) return false;
  const harness = harnessForProvider(record);
  // A harness with no capability bindings (Kilo, OpenChamber) composes onto nothing.
  if (!harness || harness.bindings.length === 0 || !spawnsRecipeBinary(record, harness)) return false;
  return providerConnectionProfile(record).reasons.length === 0;
}

/** The instance's catalog as this plan lists it — empty until the service has been asked. */
export const listedModels = (instance, catalog) => (catalog?.state === 'known'
  ? applyServicePlanFilter(instance.definition, instance.plan, Array.isArray(catalog.models) ? catalog.models : [])
  : []);

/**
 * The models a derived preset offers: the instance's plan-filtered catalog,
 * narrowed to `catalogNarrowing` when the preset declares one (in the
 * narrowing's own order, so a converted record keeps its list byte-for-byte).
 *
 * A catalog the service has not listed yet (`unknown`, or listed empty) falls
 * back to the record's own models: "Save as preset" on a freshly created
 * instance must not mint a preset with nothing to run, and a converted record
 * must not lose the list it was running with.
 */
export function derivedPresetModels(record, instance, catalog) {
  const listed = listedModels(instance, catalog);
  if (listed.length === 0) return Array.isArray(record.models) ? [...record.models] : [];
  if (!Array.isArray(record.catalogNarrowing)) return [...listed];
  const known = new Set(listed);
  return record.catalogNarrowing.filter((model) => known.has(model));
}

/**
 * The inline OpenCode config's transport half, for comparison: which
 * namespaces it declares and where each points. Permissions, agents and the
 * display `name` are harness behaviour the preset owns.
 */
function opencodeTransportShape(raw) {
  const parsed = parseOpencodeConfigContent(raw);
  if (!parsed) return null;
  const providers = parsed.provider && typeof parsed.provider === 'object' ? parsed.provider : {};
  return Object.fromEntries(Object.keys(providers).sort().map((namespace) => [namespace, {
    npm: providers[namespace]?.npm ?? null,
    baseURL: providers[namespace]?.options?.baseURL ?? null,
  }]));
}

/**
 * The env map a derived preset carries: the record's route-owned variables
 * with every service-written one laid over the top. The names the record's
 * own profile reads as connection-owned are dropped unless the service writes
 * them again — a key the service no longer supplies is not the preset's to keep.
 *
 * OpenCode's inline config is both transport and harness behaviour, so the
 * record's own string is kept whenever it already declares the namespaces and
 * base URLs the service would write: rewriting it would discard permissions
 * and agent settings the user typed into it.
 */
function mergeDerivedEnv(record, owned, materialized) {
  const routeOwned = withoutConnectionOwnedFields(record, owned).envVars || {};
  const next = { ...routeOwned, ...materialized.envVars };
  const keep = record.envVars?.OPENCODE_CONFIG_CONTENT;
  const written = materialized.envVars.OPENCODE_CONFIG_CONTENT;
  if (keep && written && isDeepStrictEqual(opencodeTransportShape(keep), opencodeTransportShape(written))) {
    next.OPENCODE_CONFIG_CONTENT = keep;
  }
  return next;
}

const includesSequence = (list, sequence) => {
  if (sequence.length === 0) return true;
  for (let i = 0; i + sequence.length <= list.length; i += 1) {
    if (sequence.every((token, j) => list[i + j] === token)) return true;
  }
  return false;
};

/**
 * The argv a derived preset runs with. `args` is the preset's own to edit, so
 * a stored list wins over the recipe's — but the tokens a BINDING appends
 * (Pi's `--provider <name>`) select the service and are kept present whatever
 * the user typed before them.
 */
function derivedPresetArgs(record, harness, materialized) {
  const recipeArgs = harness.recipe?.modes?.[record.method]?.args ?? [];
  const written = Array.isArray(materialized.args) ? materialized.args : [];
  const suffix = written.slice(recipeArgs.length);
  const base = Array.isArray(record.args) ? record.args : written;
  return includesSequence(base, suffix) ? [...base] : [...base, ...suffix];
}

/** `{ command, args, harnessId, argsSeparator }` with the spawn-time defaults applied, for comparison. */
const bootstrapShape = (bootstrap, harness) => (bootstrap?.command ? {
  command: bootstrap.command,
  args: Array.isArray(bootstrap.args) ? [...bootstrap.args] : [],
  harnessId: bootstrap.harnessId ?? harness.recipe?.command ?? null,
  argsSeparator: bootstrap.argsSeparator ?? '',
  envCommand: bootstrap.envCommand ?? null,
} : null);

/**
 * The configured bootstrap app an INLINE `credentialBootstrap` object stands
 * for, or `null`. Matched on what the spawn actually runs — command, args,
 * separator, and the name the wrapper knows this harness by — never on the
 * advisory `setupCommand`.
 *
 * @returns {{slug: string, app: object}|null}
 */
export function matchBootstrapApp(inline, harness, apps = {}) {
  const wanted = bootstrapShape(inline, harness);
  if (!wanted) return null;
  for (const [slug, app] of Object.entries(apps)) {
    const shape = bootstrapShape({ ...app, harnessId: app.harnessNames?.[harness.id] }, harness);
    if (isDeepStrictEqual(shape, wanted)) return { slug, app };
  }
  return null;
}

/**
 * The bootstrap input `materializeRoute` takes for a configured app: its slug
 * as `id` plus the spawn columns. Shared with the composite resolver.
 */
export const bootstrapInputFor = (slug, app) => ({
  id: slug,
  command: app.command,
  ...(Array.isArray(app.args) ? { args: [...app.args] } : {}),
  ...(app.argsSeparator ? { argsSeparator: app.argsSeparator } : {}),
  ...(app.envCommand ? { envCommand: [...app.envCommand] } : {}),
  ...(app.harnessNames ? { harnessNames: { ...app.harnessNames } } : {}),
});

/**
 * Re-derive a preset's connection-owned values from its service.
 *
 * `record` is the preset as stored (or as a save would store it), carrying the
 * three structural keys; `harness` its registry row; `instance` the resolved
 * service instance; `catalog` the instance's stored catalog; `bootstrap` the
 * app its `credentialBootstrapId` names, already shaped by
 * {@link bootstrapInputFor}. The result keeps every per-preset field — name,
 * argv, timeouts, model pins, effort, fallback, generation params, consent
 * flags, unknown custom fields — and rewrites only what the service owns.
 *
 * `ownedEnvNames` is the set of env variables the SERVICE wrote or the record
 * had read as connection-owned, which is what a direct edit to the record is
 * refused on.
 *
 * @returns {{record: object, error: null, ownedEnvNames: Set<string>}
 *   | {record: null, error: Error & {code: string, status: 400}, ownedEnvNames: null}}
 */
export function materializeDerivedPreset({ record, harness, instance, catalog = null, bootstrap = null }) {
  const outcome = materializeRouteOutcome({
    harness, method: record.method, serviceInstance: instance, bootstrap, providerId: record.id, name: record.name,
  });
  if (outcome.error) return { record: null, error: outcome.error, ownedEnvNames: null };
  const materialized = outcome.record;
  const { owned } = providerConnectionProfile(record);

  const envVars = mergeDerivedEnv(record, owned, materialized);
  const secretEnvVars = [...new Set([...materialized.secretEnvVars, ...liveSecretNames(record, envVars)])];

  const derived = {
    ...record,
    name: record.name ?? materialized.name,
    type: record.method,
    harnessId: harness.id,
    serviceId: instance.slug,
    command: materialized.command ?? null,
    // A direct API preset spawns nothing; `args` is written only where a program reads it.
    ...(record.method === 'api' && !Array.isArray(record.args) ? {} : { args: derivedPresetArgs(record, harness, materialized) }),
    endpoint: materialized.endpoint ?? null,
    apiKey: materialized.apiKey ?? '',
    envVars,
    secretEnvVars,
    models: derivedPresetModels(record, instance, catalog),
    timeout: record.timeout ?? materialized.timeout,
  };
  for (const key of BACKEND_MARKER_KEYS) {
    if (Object.hasOwn(materialized, key)) derived[key] = materialized[key];
    else delete derived[key];
  }
  // `servicePlan` is a fact about the instance, read from it — never a stored snapshot.
  delete derived.servicePlan;
  if (record.method === 'cli' && !Array.isArray(record.headlessArgs)) derived.headlessArgs = materialized.headlessArgs ?? [];
  if (record.method === 'tui' && record.tuiPromptDelayMs == null && materialized.tuiPromptDelayMs != null) {
    derived.tuiPromptDelayMs = materialized.tuiPromptDelayMs;
  }
  if (materialized.credentialBootstrap) {
    // `setupCommand` is advisory text the editor shows; the app row does not
    // carry it into the spawn columns, so the record's own survives.
    const setupCommand = record.credentialBootstrap?.setupCommand;
    derived.credentialBootstrap = { ...(setupCommand ? { setupCommand } : {}), ...materialized.credentialBootstrap };
    derived.credentialBootstrapId = bootstrap?.id ?? record.credentialBootstrapId;
  } else {
    delete derived.credentialBootstrap;
    delete derived.credentialBootstrapId;
  }
  const ownedEnvNames = new Set([...Object.keys(owned.envVars), ...Object.keys(materialized.envVars)]);
  return { record: derived, error: null, ownedEnvNames };
}

/**
 * The record's declared secret names that carry a value in `envVars`. A name
 * with no value masks and exports nothing (every shipped Zen preset declares an
 * unset `OPENCODE_API_KEY`), so derivation drops it and drift ignores it.
 */
const liveSecretNames = (record, envVars) =>
  (Array.isArray(record.secretEnvVars) ? record.secretEnvVars : []).filter((name) => Object.hasOwn(envVars, name));

const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));
const orNull = (value) => value ?? null;

/**
 * The connection-owned keys on which `derived` disagrees with `record` —
 * empty when re-deriving the record is a FIXPOINT, which is the one condition
 * under which a legacy preset may be converted without changing how it runs.
 */
export function derivedPresetDrift(record, derived, harness) {
  const drift = [];
  // A `*Backed`/`gatewayBacked` marker is read back by `localRuntimeNamespace`
  // to give a WRAPPER command its local namespace; `materializeRoute` writes
  // one onto every local-runtime composition regardless, including a direct
  // `type: 'api'` record that spawns nothing and never reads it. The shipped
  // `ollama` / `lmstudio` / `mtplx` samples predate the graph and carry none,
  // so comparing markers on a recipe-less (direct) harness would refuse a
  // fixpoint conversion over a field the record's own execution path ignores
  // (#8159). A WRAPPER's marker still participates — it is what makes
  // `opencode-orcarouter`'s legacy `orcarouterBacked` a real drift.
  const markerKeys = harness.recipe ? BACKEND_MARKER_KEYS : [];
  for (const key of ['type', 'command', ...markerKeys]) {
    if (!isDeepStrictEqual(orNull(record[key]), orNull(derived[key]))) drift.push(key);
  }
  // A wrapper that names its endpoint only inside its env or inline config
  // (every shipped OpenCode-on-Ollama sample) gains the field; that changes
  // what the readiness probe reads, never what the program runs.
  if (typeof record.endpoint === 'string' && record.endpoint !== '' && record.endpoint !== orNull(derived.endpoint)) drift.push('endpoint');
  if ((record.apiKey ?? '') !== (derived.apiKey ?? '')) drift.push('apiKey');
  if (!isDeepStrictEqual(record.envVars ?? {}, derived.envVars)) drift.push('envVars');
  if (!sameSet(liveSecretNames(record, record.envVars ?? {}), derived.secretEnvVars)) drift.push('secretEnvVars');
  if (!isDeepStrictEqual(bootstrapShape(record.credentialBootstrap, harness), bootstrapShape(derived.credentialBootstrap, harness))) {
    drift.push('credentialBootstrap');
  }
  if (!isDeepStrictEqual(Array.isArray(record.models) ? record.models : [], derived.models)) drift.push('models');
  return drift;
}

/**
 * The keys of `updates` that would move a connection-owned value away from
 * what the service derives — the edits a derived preset refuses, pointing at
 * the service instead. Values matching either the current derivation or the
 * persisted record are a no-op: the editor sends the whole record back on
 * every save, and service changes can make that saved copy stale.
 *
 * @param {object} updates - the patch a client sent (secrets already restored)
 * @param {object} derived - the record materialization would store
 * @param {Set<string>} ownedEnvNames - from {@link materializeDerivedPreset}
 * @param {object|null} [previous] - the persisted record before this update
 * @returns {string[]}
 */
export function refusedDerivedEdits(updates, derived, ownedEnvNames, previous = null) {
  const refused = [];
  for (const key of DERIVED_PRESET_OWNED_KEYS) {
    if (!Object.hasOwn(updates, key)) continue;
    if (key === 'secretEnvVars') {
      const updated = Array.isArray(updates[key]) ? updates[key] : [];
      const current = Array.isArray(derived[key]) ? derived[key] : [];
      const before = Array.isArray(previous?.[key]) ? previous[key] : [];
      if (!sameSet(updated, current) && (!previous || !sameSet(updated, before))) refused.push(key);
      continue;
    }
    const normalize = key === 'apiKey' ? (value) => value ?? '' : orNull;
    const updated = normalize(updates[key]);
    const matchesCurrent = isDeepStrictEqual(updated, normalize(derived[key]));
    const matchesPrevious = previous && isDeepStrictEqual(updated, normalize(previous[key]));
    if (!matchesCurrent && !matchesPrevious) refused.push(key);
  }
  if (updates.envVars && typeof updates.envVars === 'object') {
    for (const name of ownedEnvNames) {
      const updated = updates.envVars[name] ?? null;
      const matchesCurrent = updated === (derived.envVars[name] ?? null);
      const matchesPrevious = previous && updated === (previous.envVars?.[name] ?? null);
      if (!matchesCurrent && !matchesPrevious) refused.push('envVars.' + name);
    }
  }
  return refused;
}

/** The keys of `derived` whose value differs from `record` — the patch a re-projection writes. */
export function derivedPresetPatch(record, derived) {
  const patch = {};
  for (const [key, value] of Object.entries(derived)) {
    if (!isDeepStrictEqual(record[key], value)) patch[key] = value;
  }
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(derived, key)) patch[key] = undefined;
  }
  return patch;
}

/**
 * The `catalogNarrowing` that keeps a record on the model list it already
 * runs once it is derived from a service listing `listed`: its own list, when
 * that is a strict, fully listed subset; `null` when no narrowing is needed or
 * none would hold. Shared by the conversion backfill and the service fold.
 */
export function impliedCatalogNarrowing(record, listed) {
  const models = Array.isArray(record.models) ? record.models : [];
  return listed.length > 0 && !isDeepStrictEqual(listed, models) && models.every((model) => listed.includes(model))
    ? [...models]
    : null;
}

/**
 * Re-derive one DERIVED preset from `instance`: the materialized record and the
 * patch that writes it, or `null` when it cannot be derived there (an unknown
 * harness, a missing bootstrap app, a refused composition).
 *
 * @param {object} record - a derived preset, possibly with its structural keys already retargeted
 * @param {{instance: object, catalog: object|null, bootstraps: Record<string, object>, stored?: object}} context
 *   `stored` is the record as persisted, which the patch is taken against (defaults to `record`)
 * @returns {{derived: object, patch: object}|null}
 */
export function rederivePreset(record, { instance, catalog, bootstraps, stored = record }) {
  const harness = harnessById(record.harnessId);
  const app = record.credentialBootstrapId ? bootstraps[record.credentialBootstrapId] : null;
  if (!harness || (record.credentialBootstrapId && !app)) return null;
  const { record: derived } = materializeDerivedPreset({
    record, harness, instance, catalog, bootstrap: app ? bootstrapInputFor(record.credentialBootstrapId, app) : null,
  });
  return derived ? { derived, patch: derivedPresetPatch(stored, derived) } : null;
}

/**
 * The backfill verdict for ONE legacy record already resolved onto the graph
 * — the additive structural patch when re-deriving it from `connection` is a
 * FIXPOINT, or the reason it stays legacy. Pulled out of `planPresetBackfill`'s
 * loop body (#8159) so a caller that already knows which route/connection a
 * record sits on can ask the exact same question about just THAT record,
 * without rebuilding the whole-graph maps `planPresetBackfill` needs to
 * resolve every record at once. `providerGraph.js`'s
 * `refreshPresetSkipReasonsForConnection` is the worked example: a connection
 * SETTINGS edit changes what this verdict answers for every legacy route on
 * that one connection, without writing `providers.json` (so it never triggers
 * the reconcile pass that would otherwise keep `presetSkipReason` current).
 *
 * `route`, `connection` and `instance` arrive pre-resolved (a caller looping
 * over many records resolves an instance once per connection; a single-record
 * caller resolves it inline) rather than re-read here, so this function stays
 * pure over its inputs.
 *
 * @param {object} record - a LEGACY provider record (caller has already
 *   excluded a derived preset)
 * @param {{route: object|null, connection: object|null, instance: object|null,
 *          bootstraps?: object, env?: object}} resolved
 * @returns {{patch: object, reason: null} | {patch: null, reason: string}}
 */
export function presetBackfillVerdict(record, { route, connection, instance, bootstraps = {}, env = process.env }) {
  const refuse = (reason) => ({ patch: null, reason });
  if (!route) return refuse('unmapped');
  if (!connection?.slug) return refuse('service-unnamed');
  if (!instance) return refuse('service-undefined');
  const harness = harnessForProvider(record);
  if (!harness) return refuse('harness-unknown');
  if (!spawnsRecipeBinary(record, harness)) return refuse('command-differs');

  const match = matchBootstrapApp(record.credentialBootstrap, harness, bootstraps);
  if (record.credentialBootstrap?.command && !match) return refuse('bootstrap-unmatched');
  const structural = {
    harnessId: harness.id,
    method: record.type,
    serviceId: connection.slug,
    ...(match ? { credentialBootstrapId: match.slug } : {}),
  };
  const narrowing = impliedCatalogNarrowing(record, listedModels(instance, connection.catalog));
  if (narrowing) structural.catalogNarrowing = narrowing;

  const { record: derived, error } = materializeDerivedPreset({
    record: { ...record, ...structural },
    harness,
    instance,
    catalog: connection.catalog,
    bootstrap: match ? bootstrapInputFor(match.slug, match.app) : null,
  });
  if (error) return refuse(error.code);
  const drift = derivedPresetDrift(record, derived, harness);
  if (drift.length > 0) return refuse(`drift:${drift.join(',')}`);
  return { patch: structural, reason: null };
}

/**
 * The boot-time backfill (#7565): every LEGACY record the graph already routes
 * onto a named service instance, stamped with the structural keys that make it
 * a derived preset — but ONLY when re-deriving it from that service reproduces
 * every connection-owned value it carries today. The patch is additive
 * (`harnessId`, `method`, `serviceId`, an optional `credentialBootstrapId` for
 * an inline bootstrap matching a configured app, and a `catalogNarrowing` when
 * the record lists a subset of the catalog), so the file diff is keys added
 * and nothing rewritten.
 *
 * Row-derived, idempotent (a stamped record is skipped) and never a seed:
 * it needs the graph, so it rides the reconcile pass exactly as the
 * service-column backfill does. Everything it refuses is reported with a
 * reason so a human can see why a record stayed legacy — the per-record rule
 * is {@link presetBackfillVerdict}; this loop only resolves each record onto
 * the graph (caching one service instance per connection across mode
 * siblings) and collects the verdicts.
 *
 * @param {{graph: {connections: object[], bindings: object[], routes: object[]},
 *          providers: object[], bootstraps?: object, env?: object}} input
 * @returns {{patches: Record<string, object>, skipped: {id: string, reason: string}[]}}
 */
export function planPresetBackfill({ graph, providers, bootstraps = {}, env = process.env }) {
  const routes = new Map(graph.routes.map((route) => [route.providerId, route]));
  const bindings = new Map(graph.bindings.map((binding) => [binding.id, binding]));
  const connections = new Map(graph.connections.map((connection) => [connection.id, connection]));
  const patches = {};
  const skipped = [];
  // Mode siblings share one row; resolve its instance once.
  const instances = new Map();
  const instanceFor = (connection) => {
    if (!instances.has(connection.id)) instances.set(connection.id, instanceForConnection(connection, env));
    return instances.get(connection.id);
  };

  for (const record of providers) {
    if (!record || typeof record !== 'object' || !record.id || isDerivedPreset(record)) continue;
    const route = routes.get(record.id) ?? null;
    const connection = route ? connections.get(bindings.get(route.bindingId)?.connectionId) ?? null : null;
    const instance = connection?.slug ? instanceFor(connection) : null;
    const { patch, reason } = presetBackfillVerdict(record, { route, connection, instance, bootstraps, env });
    if (reason) { skipped.push({ id: record.id, reason }); continue; }
    patches[record.id] = patch;
  }
  return { patches, skipped };
}
