import { CONNECTION_CREDENTIAL_ENV_VARS, CONNECTION_PROTOCOLS } from './providerConnections.js';
import { modeSiblingId } from './aiToolkit/internal/providerModes.js';
import { PROVIDER_GATEWAYS } from './providerGateways.js';
import {
  CREATABLE_HARNESS_IDS,
  firstCompatibleBinding,
  graphHarnessId,
  harnessById,
  harnessConnectionBlocker,
  harnessRecipe,
} from './providerHarnesses.js';
import { LOCAL_RUNTIMES } from './localProviderRuntime.js';
import { resolveServiceInstance, serviceError } from './serviceDefinitions.js';

/**
 * Minting a FRESH executable route from a connection and a harness recipe
 * (#6369) — the half of the connection graph that creates rather than
 * classifies.
 *
 * `providerConnections.js` reads an existing record and answers what backend it
 * describes. This module runs that in reverse: given a connection row and a
 * harness's command recipe, it produces the `data/providers.json` record that
 * would reach that backend through that program. `POST /api/providers/bindings`
 * is its only caller, and it verifies the result by feeding it straight back
 * through `providerConnectionProfile` — a minted route that does not describe
 * the connection it was minted for is refused rather than stored, because the
 * reconciler would otherwise clone it onto a connection of its own.
 *
 * Pure: no I/O, no clock, no spawn. Nothing here contacts an AI provider or
 * launches anything — a created route arrives DISABLED and is executed only
 * after the human enables it on the route editor.
 */

/**
 * Backend kinds a connection may be created for, and the record marker that
 * makes a minted route resolve to each one.
 *
 * These markers are what the spawner itself keys on (`localRuntimeNamespace`,
 * `gatewayIdForProvider`), so setting the right one is what gives an OpenCode
 * route its `<namespace>/` model prefix and points a model refresh at the
 * daemon instead of the harness.
 *
 * `slotstream` is deliberately absent: it carries no `*Backed` marker of its
 * own and is resolved by id, name or port, so a minted route could not be made
 * to describe it honestly. `vendor` is absent for the opposite reason — a
 * vendor's own hosted service is not a backend the user supplies.
 */
const LOCAL_RUNTIME_MARKERS = Object.freeze({
  ollama: 'ollamaBacked',
  lmstudio: 'lmstudioBacked',
  mtplx: 'mtplxBacked',
  llama: 'llamaBacked',
  vllm: 'vllmBacked',
  sglang: 'sglangBacked',
});

/** Every `kind` `POST /api/providers/connections` accepts. */
export const CREATABLE_CONNECTION_KINDS = Object.freeze([
  ...Object.keys(LOCAL_RUNTIME_MARKERS),
  ...PROVIDER_GATEWAYS.map((gateway) => `gateway:${gateway.id}`),
  // A bare OpenAI-compatible endpoint with no local daemon and no gateway row
  // behind it — the "separate remote API" case in the design record.
  'api',
]);

/** A human label for a connection kind, for the picker and for minted route names. */
export const connectionKindLabel = (kind) => LOCAL_RUNTIMES[kind]?.label
  || PROVIDER_GATEWAYS.find((gateway) => `gateway:${gateway.id}` === kind)?.label
  || (kind === 'api' ? 'Direct API' : kind);

/** The record markers a route on this connection kind must carry, or `null` for an unknown kind. */
export function connectionKindMarkers(kind) {
  if (LOCAL_RUNTIME_MARKERS[kind]) return { [LOCAL_RUNTIME_MARKERS[kind]]: true };
  const gateway = PROVIDER_GATEWAYS.find((candidate) => `gateway:${candidate.id}` === kind);
  if (gateway) return { gatewayBacked: gateway.id };
  return kind === 'api' ? {} : null;
}

/**
 * The OpenCode provider namespace a connection kind maps to.
 *
 * The same key space `getOpencodeLocalProviderNamespace` reads back off the
 * markers above, so the inline config this module writes and the model prefix
 * the spawner applies can never name different namespaces.
 */
const opencodeNamespace = (kind) => (kind.startsWith('gateway:') ? kind.slice('gateway:'.length) : kind);

/**
 * The wire protocol a binding needs the connection to speak.
 *
 * A direct API binding has no harness and talks the OpenAI-compatible wire,
 * which is exactly what `providerConnectionProfile` reports for a bare `api`
 * record — so the two agree by construction rather than by coincidence.
 */
export const bindingProtocol = (harnessId) => (harnessId ? harnessById(harnessId)?.protocol ?? null : 'openai');

/**
 * Why this backend cannot be created, or `null`.
 *
 * The counterpart of {@link bindingBlocker}, and the reason both live here
 * rather than in a Zod schema: the registries these answers come from are the
 * same ones a minted record is built from, and `lib/validation.js` is imported
 * by nearly every route in PortOS.
 *
 * @returns {{code:string, message:string}|null}
 */
export function connectionBlocker({ kind, transports }) {
  if (!CREATABLE_CONNECTION_KINDS.includes(kind)) {
    return {
      code: 'PROVIDER_GRAPH_KIND_UNSUPPORTED',
      message: `A route cannot describe a "${kind}" backend. Choose one of: ${CREATABLE_CONNECTION_KINDS.join(', ')}.`,
    };
  }
  const [protocol] = Object.keys(transports || {});
  if (!CONNECTION_PROTOCOLS.includes(protocol)) {
    return {
      code: 'PROVIDER_GRAPH_PROTOCOL_UNSUPPORTED',
      message: `"${protocol}" is not a transport protocol PortOS speaks. Choose one of: ${CONNECTION_PROTOCOLS.join(', ')}.`,
    };
  }
  return null;
}

/**
 * Why this connection cannot carry a route for this harness, or `null`.
 *
 * The transport rule is CONTAINMENT: the connection must declare the harness's
 * protocol, and may declare others beside it. It once demanded that protocol
 * and nothing else, because reconciliation asked a route to describe its
 * connection EXACTLY and so cloned a route minted onto a two-protocol row
 * straight back off it on the next pass. #6452 replaced that equality test
 * with containment (`routeBelongsOnConnection`), which is what lets a second
 * harness be CREATED on one multi-protocol daemon rather than only linked onto
 * it (#6460) — an Ollama daemon reached by Claude on its Anthropic port and by
 * Codex on its `/v1` port is one backend, and both routes stay on it.
 *
 * A connection declaring NO transport is still refused: a row naming no
 * endpoint cannot carry a route at all.
 *
 * @returns {{code:string, message:string}|null}
 */
export function bindingBlocker({ harnessId: requestedHarnessId, modes, connection }) {
  // The graph's vocabulary is `null` for a direct API binding; the registry's
  // is `direct`. Either spelling means the same thing here.
  const harnessId = graphHarnessId(requestedHarnessId);
  if (harnessId !== null && !CREATABLE_HARNESS_IDS.includes(harnessId)) {
    return {
      code: 'PROVIDER_HARNESS_NOT_CREATABLE',
      // The REASON is the row's (`noRecipe` / `connectionLimit` in
      // providerHarnesses.js), not this string's: several different things make
      // a harness uncreatable, and a hardcoded clause here told two of them the
      // wrong one — sending a user looking for a vendor service when the real
      // remedy is their own config file or a runtime they have to start.
      message: `${harnessById(harnessId)?.label || harnessId} ${harnessConnectionBlocker(harnessId) || 'has no command recipe'}, so it cannot be pointed at a backend connection. Add it from the provider editor instead.`,
    };
  }
  const harness = harnessId ? harnessById(harnessId) : null;
  const unsupported = modes.filter((mode) => (harness ? !harness.modes.includes(mode) : mode !== 'api'));
  if (unsupported.length > 0) {
    return {
      code: 'PROVIDER_HARNESS_MODE_UNSUPPORTED',
      message: `${harness?.label || 'A direct API binding'} has no ${unsupported.join(', ')} mode.`,
    };
  }

  const protocol = bindingProtocol(harnessId);
  const declared = Object.keys(connection.transports || {});
  if (!declared.includes(protocol)) {
    return {
      code: 'PROVIDER_GRAPH_TRANSPORT_MISMATCH',
      message: `This backend declares ${declared.length > 0 ? declared.join(', ') : 'no'} transport(s); a ${harness?.label || 'direct API'} route needs a backend that declares ${protocol}.`,
    };
  }

  const credential = harnessId ? harnessRecipe(harnessId)?.credential : null;
  const key = credential?.via === 'env' ? credential.name : 'apiKey';
  if (credential?.required && !connection.credentials?.[key]) {
    return {
      code: 'PROVIDER_GRAPH_CREDENTIAL_REQUIRED',
      message: `${harness.label} will not start without a ${key}. Set one on this backend first — any non-empty value works for a local daemon that ignores it.`,
    };
  }
  return null;
}

/** The base URL a connection declares for `protocol`. */
const connectionBaseUrl = (connection, protocol) => connection.transports?.[protocol]?.baseUrl ?? null;

/**
 * OpenCode's inline provider declaration for one namespace and base URL, or
 * the permission-only form for a provider OpenCode already ships (`builtin`).
 */
const opencodeProviderConfig = ({ namespace, label, baseUrl, builtin = false }) => JSON.stringify({
  permission: 'allow',
  ...(builtin ? {} : {
    provider: {
      [namespace]: {
        npm: '@ai-sdk/openai-compatible',
        name: label,
        options: { baseURL: baseUrl },
      },
    },
  }),
});

const opencodeConfigContent = (kind, baseUrl) =>
  opencodeProviderConfig({ namespace: opencodeNamespace(kind), label: connectionKindLabel(kind), baseUrl });

/**
 * The executable record for one freshly minted route.
 *
 * Every connection-owned value is materialized into the record, exactly as a
 * later projection would write it, so the row this create stores as `projected`
 * is already true of the file and the next reconciliation pass is a no-op.
 *
 * The record arrives **disabled and unpinned**: no `defaultModel`, no models,
 * no transport consent. Creating a route is a management act; executing one is
 * a separate, explicit grant on the route editor.
 *
 * @param {{harnessId:string|null, mode:'cli'|'tui'|'api', providerId:string,
 *          name:string, connection:{kind:string, transports:object, credentials:object}}} input
 * @returns {object} the record to hand `createProvider`
 */
export function buildRouteRecord({ harnessId, mode, providerId, name, connection }) {
  const recipe = harnessId ? harnessRecipe(harnessId) : null;
  const baseUrl = connectionBaseUrl(connection, bindingProtocol(harnessId));
  const credentials = connection.credentials || {};
  const envVars = {};
  const secretEnvVars = [];

  if (recipe?.baseUrl?.via === 'env') envVars[recipe.baseUrl.name] = baseUrl;
  if (recipe?.baseUrl?.via === 'opencodeConfig') {
    envVars.OPENCODE_CONFIG_CONTENT = opencodeConfigContent(connection.kind, baseUrl);
  }
  // Every credential the connection holds is materialized, not just the one
  // the recipe names: the connection is the source of truth, and a minted route
  // that carried a SUBSET would no longer describe the backend it was minted
  // for. Keys outside the recognized set are skipped rather than written as
  // stray env vars, because `providerConnectionProfile` would not read one back
  // as a credential — the two halves have to name the same thing.
  for (const [key, value] of Object.entries(credentials)) {
    if (key === 'apiKey' || !CONNECTION_CREDENTIAL_ENV_VARS.includes(key)) continue;
    envVars[key] = value;
    secretEnvVars.push(key);
  }
  // Claude Code refuses to start without its auth token, so a recipe that
  // declares one always declares the variable — empty only if the guard above
  // let a credential-less connection through, which it does not for a required
  // credential.
  if (recipe?.credential?.via === 'env' && !Object.hasOwn(envVars, recipe.credential.name)) {
    envVars[recipe.credential.name] = '';
  }

  return {
    id: providerId,
    name,
    type: mode,
    // `endpoint` is connection-owned on every record shape a projection can
    // write, so setting it here keeps the minted record identical to what the
    // first `PATCH /connections/:id` would produce.
    endpoint: baseUrl,
    apiKey: credentials.apiKey ?? '',
    // `null` for a kind no marker describes — an imported legacy connection can
    // carry one. The record then simply has no marker, and the caller's identity
    // check is what decides whether it still describes this backend.
    ...(connectionKindMarkers(connection.kind) || {}),
    ...executableRecordTail({ recipe, mode, enabled: false, envVars, secretEnvVars }),
  };
}

/** Default wall clock for a record no recipe times — every shipped `api` sample. */
const API_ROUTE_TIMEOUT_MS = 300000;

/**
 * The half of an executable record that every writer here assembles the same
 * way: the program and its per-mode argv (or the API wall clock when there is
 * no program), an empty catalog, and the env maps. Stated once so a new marker
 * or env rule lands in {@link buildRouteRecord} and {@link materializeRoute}
 * together.
 */
const executableRecordTail = ({ recipe, mode, args, enabled, envVars, secretEnvVars }) => {
  const modeRecipe = recipe?.modes?.[mode] ?? null;
  return {
    ...(recipe ? { command: recipe.command, timeout: recipe.timeout } : { timeout: API_ROUTE_TIMEOUT_MS }),
    ...(modeRecipe ? { ...modeRecipe, ...(args ? { args } : {}) } : {}),
    models: [],
    defaultModel: null,
    enabled,
    envVars,
    secretEnvVars,
  };
};

/**
 * Route ids for a new binding's modes: readable, stable and free.
 *
 * The sibling id comes from `modeSiblingId`, declared beside the
 * `providerModeGroups` reader that pairs on it — mint one any other way and the
 * toolkit stops treating the two modes as one harness on one backend. The whole
 * set is suffixed together for the same reason: uniquifying each id on its own
 * would break the stem relationship the moment one half collided.
 *
 * @param {{harnessId:string|null, kind:string, modes:string[], taken:Set<string>}} input
 * @returns {Record<string,string>} mode → provider id
 */
export function mintRouteIds({ harnessId, kind, modes, taken }) {
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stem = [harnessId, kind].filter(Boolean).map(slug).join('-') || 'route';
  const idsFor = (base) => Object.fromEntries(modes.map((mode) => [mode, modeSiblingId(base, mode)]));

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const ids = idsFor(suffix === 0 ? stem : `${stem}-${suffix + 1}`);
    if (Object.values(ids).every((id) => !taken.has(id))) return ids;
  }
  // Unreachable with any realistic install; a bounded loop beats an unbounded
  // one, and an explicit throw beats returning a colliding id.
  throw new Error(`Could not mint a free route id for ${stem}`);
}

/**
 * The record markers a materialized route on a service definition must carry,
 * so the spawner and `providerConnectionProfile` classify it onto that service:
 * the runtime's `*Backed` boolean, or `gatewayBacked: '<id>'`. Slotstream and
 * a plain API endpoint carry none, exactly as {@link connectionKindMarkers}.
 */
const serviceMarkers = (definition, { wrapper }) => {
  if (definition.localRuntime) return connectionKindMarkers(definition.localRuntime) || {};
  // `gatewayBacked` marks a WRAPPER — a program spawned in front of a gateway
  // (the sibling api record owns the key). A record that IS the client carries
  // none, exactly as every shipped `api` sample.
  if (definition.gateway && wrapper) return { gatewayBacked: definition.id };
  return {};
};

/**
 * The connection kind a service instance reads back as — the same key space
 * {@link connectionKindMarkers} and {@link opencodeNamespace} are keyed on, so
 * a materialized OpenCode config names the namespace its marker resolves to.
 */
const serviceConnectionKind = ({ definition, slug }) =>
  definition.localRuntime || (definition.gateway ? `gateway:${definition.id}` : slug);

/**
 * The executable record for a (harness, method, service) composition (#7562) —
 * {@link buildRouteRecord} generalized from "a connection" to "a service
 * instance", and from "one recipe" to "the first compatible binding".
 *
 * Given a harness row (or id), the execution method, a service instance (see
 * `resolveServiceInstance`), an optional credential-bootstrap app, and the
 * model/effort selection, it writes every value the binding says the program
 * reads — base URL, credential, static env, backend markers, inline
 * OpenCode/Pi selection — plus the recipe's per-mode argv, so the result is a
 * complete `data/providers.json` record with no further lookup. Feeding it
 * back through `providerConnectionProfile` classifies it onto the same
 * service ({@link routeDescribesService}), which is the contract
 * `createBinding` already holds a minted route to.
 *
 * Pure: no I/O, no clock, no spawn. Throws a typed error (`err.code`) rather
 * than minting a route that cannot run:
 *   - `HARNESS_UNKNOWN` / `HARNESS_METHOD_UNSUPPORTED`
 *   - `HARNESS_SERVICE_INCOMPATIBLE` — no binding reaches this service
 *   - `SERVICE_ENDPOINT_REQUIRED` — the binding needs a base URL the instance
 *     does not declare (a local daemon's port is an install-specific fact)
 *   - `SERVICE_CREDENTIAL_REQUIRED` — the program refuses to start without one
 *   - `SERVICE_CREDENTIAL_BOOTSTRAP_REQUIRED` — the instance's credential is
 *     minted by a bootstrap CLI at spawn, and none was supplied
 *
 * @param {{harness: object|string, method: 'cli'|'tui'|'api',
 *          serviceInstance: object|string,
 *          bootstrap?: {id?: string, command: string, args?: string[], argsSeparator?: string, harnessNames?: Record<string,string>}|null,
 *          selection?: {model?: string|null, effort?: string|null, tiers?: Record<string,string>},
 *          overrides?: object, providerId?: string, name?: string}} input
 * @returns {object} the record to hand `createProvider`
 */
export function materializeRoute(input) {
  const { record, error } = materializeRouteOutcome(input);
  if (error) throw error;
  return record;
}

/**
 * {@link materializeRoute} as a VERDICT: `{ record }` when the composition is
 * runnable, `{ error }` (the same typed 400) when it is not. The composite
 * resolver (#7564) reads refusals as reasons to show beside a saved selection,
 * so it needs the answer without a throw; the create endpoint keeps the
 * throwing form. One body, two shapes.
 *
 * @returns {{record: object, error: null}|{record: null, error: Error & {code: string, status: 400}}}
 */
export function materializeRouteOutcome({
  harness: harnessInput, method, serviceInstance, bootstrap = null, selection = {}, overrides = {}, providerId, name,
}) {
  const refuse = (code, message) => ({ record: null, error: serviceError(code, message) });
  const harness = typeof harnessInput === 'string' ? harnessById(harnessInput) : harnessInput;
  if (!harness) return refuse('HARNESS_UNKNOWN', `No harness "${harnessInput ?? ''}"`);
  if (!harness.modes.includes(method)) {
    return refuse('HARNESS_METHOD_UNSUPPORTED', `${harness.label} has no ${method} mode.`);
  }
  const instance = resolveServiceInstance(serviceInstance);
  const { definition } = instance;
  const binding = firstCompatibleBinding(harness, instance);
  if (!binding) {
    return refuse('HARNESS_SERVICE_INCOMPATIBLE', `${harness.label} cannot be pointed at ${definition.label}.`);
  }
  if (instance.credentialVia === 'bootstrap' && method !== 'api' && !bootstrap) {
    return refuse('SERVICE_CREDENTIAL_BOOTSTRAP_REQUIRED',
      `${definition.label} is credentialed by a bootstrap CLI at spawn; name the bootstrap app to compose this route.`);
  }

  const recipe = harness.recipe;
  const envVars = {};
  const secretEnvVars = [];
  const fields = {};
  const args = [...(recipe?.modes?.[method]?.args || [])];
  const apiKey = typeof instance.credentials.apiKey === 'string' ? instance.credentials.apiKey : '';

  // --- endpoint --------------------------------------------------------------
  const protocol = binding.protocol || null;
  const baseUrl = protocol ? instance.transports[protocol]?.baseUrl ?? null : null;
  if (protocol && !baseUrl) {
    return refuse('SERVICE_ENDPOINT_REQUIRED', `${definition.label} declares no ${protocol} endpoint; set its base URL first.`);
  }
  switch (binding.baseUrl?.via) {
    case 'env': envVars[binding.baseUrl.name] = baseUrl; break;
    case 'opencodeConfig':
      envVars.OPENCODE_CONFIG_CONTENT = opencodeProviderConfig({
        namespace: opencodeNamespace(serviceConnectionKind(instance)), label: definition.label, baseUrl, builtin: binding.baseUrl.builtin === true,
      });
      break;
    case 'piProvider': args.push(binding.baseUrl.flag, definition.piProvider); break;
    default: break;
  }
  // A binding that writes an endpoint also records it on the record: as
  // `endpoint` for a program that reads that field, and beside an env var,
  // inline config or provider name as every shipped wrapper sample does — the
  // readiness probe and the catalog refresh read it off the record. A binding
  // that writes none (the program signs in itself) records none.
  // `endpoint` is the OpenAI-compatible URL everywhere it is read (catalog
  // probes, the local-runtime classifier), so an Anthropic-only service records
  // none.
  const endpoint = !binding.baseUrl ? null
    : binding.baseUrl.via === 'field' ? baseUrl : instance.transports.openai?.baseUrl ?? null;
  if (endpoint) fields.endpoint = endpoint;

  // --- credential ------------------------------------------------------------
  const credential = binding.credential || null;
  // A `gatewayEnv` credential lands under the gateway's own variable (what the
  // spawner exports for OpenCode); on a service that is not a gateway it lands
  // on the record's `apiKey`, which the inline-config builder attaches at spawn.
  const credentialVia = credential?.via === 'gatewayEnv' && !definition.gateway ? 'field' : credential?.via;
  const credentialEnvName = credentialVia === 'gatewayEnv'
    ? definition.gateway.apiKeyEnv
    : credentialVia === 'env' ? credential.name ?? definition.credential.envVars[0] ?? null : null;
  const credentialRequired = credential?.required === true && instance.credentialVia !== 'bootstrap';
  if (credentialRequired && apiKey === '') {
    return refuse('SERVICE_CREDENTIAL_REQUIRED',
      `${harness.label} will not start without a ${credentialEnvName || 'key'} for ${definition.label}. Set one first — any non-empty value works for a local daemon that ignores it.`);
  }
  if (credentialVia === 'field') fields.apiKey = apiKey;
  if (credentialEnvName && (apiKey !== '' || credentialRequired)) {
    envVars[credentialEnvName] = apiKey;
    secretEnvVars.push(credentialEnvName);
  }
  Object.assign(envVars, binding.env || {});

  // --- assembly --------------------------------------------------------------
  const tiers = selection.tiers && typeof selection.tiers === 'object' ? selection.tiers : {};
  const record = {
    id: providerId ?? `${harness.id}.${method}@${instance.slug}${bootstrap ? `+${bootstrap.id ?? bootstrap.command}` : ''}`,
    name: name ?? `${harness.label} · ${definition.label}`,
    type: method,
    harnessId: harness.id,
    method,
    serviceId: instance.slug,
    servicePlan: instance.plan,
    ...fields,
    ...serviceMarkers(definition, { wrapper: Boolean(recipe) }),
    ...executableRecordTail({ recipe, mode: method, args, enabled: true, envVars, secretEnvVars }),
    defaultModel: selection.model ?? null,
    ...(selection.effort ? { effort: selection.effort } : {}),
    ...tiers,
    ...overrides,
  };
  if (bootstrap && method !== 'api') {
    record.credentialBootstrap = {
      command: bootstrap.command,
      ...(Array.isArray(bootstrap.args) ? { args: [...bootstrap.args] } : {}),
      // The bootstrap CLI's own name for this harness, when it differs from the
      // binary PortOS spawns — `resolveCliSpawn` reads it unchanged.
      harnessId: bootstrap.harnessNames?.[harness.id] ?? recipe.command,
      ...(bootstrap.argsSeparator ? { argsSeparator: bootstrap.argsSeparator } : {}),
    };
  }
  return { record, error: null };
}

/**
 * Whether a record's connection profile describes `serviceInstance`: it
 * classifies onto the service's backend kind, and every endpoint it declares is
 * one the instance is reached at. The round-trip contract `materializeRoute`
 * owes, stated once so its test and a later store can share it.
 *
 * @param {ReturnType<typeof import('./providerConnections.js').providerConnectionProfile>} profile
 * @param {object} serviceInstance - resolved
 */
export function routeDescribesService(profile, serviceInstance) {
  const instance = resolveServiceInstance(serviceInstance);
  const { definition } = instance;
  // A wrapper on a gateway reads back as `gateway:<id>`; a direct API record
  // on the same gateway reads back as `api` (it carries no marker, see
  // `serviceMarkers`). Both are that service.
  const expectedKinds = definition.localRuntime ? [definition.localRuntime]
    : definition.gateway ? [`gateway:${definition.id}`, 'api']
      : ['api', 'vendor'];
  if (!expectedKinds.includes(profile.kind)) return false;
  return Object.entries(profile.transports).every(([protocol, transport]) =>
    transport.baseUrl === instance.transports[protocol]?.baseUrl);
}
