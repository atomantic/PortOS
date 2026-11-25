/**
 * Materializing an executable route from a service instance and a harness recipe — the
 * reverse of `providerConnections.js`, which reads an existing record.
 */

import { CONNECTION_PROTOCOLS } from './providerConnections.js';
import { PROVIDER_GATEWAYS } from './providerGateways.js';
import {
  firstCompatibleBinding,
  harnessById,
} from './providerHarnesses.js';
import { LOCAL_RUNTIME_MARKERS, LOCAL_RUNTIME_MARKER_KEYS } from '../aiToolkit/internal/localRuntimeMarkers.js';
import { resolveServiceInstance, serviceError } from '../serviceDefinitions.js';

/**
 * Every record key a backend marker can sit under: the local-runtime booleans,
 * the generic gateway marker, and each gateway's legacy per-gateway boolean —
 * so a writer that has to CLEAR a stale marker (a preset re-derived from a
 * different service, #7565) names the same set this module writes.
 */
export const BACKEND_MARKER_KEYS = Object.freeze([
  ...LOCAL_RUNTIME_MARKER_KEYS,
  'gatewayBacked',
  ...PROVIDER_GATEWAYS.flatMap((gateway) => (gateway.legacyMarker ? [gateway.legacyMarker] : [])),
]);

/** Backend kinds supported by connection creation. */
const CREATABLE_CONNECTION_KINDS = Object.freeze([
  ...Object.keys(LOCAL_RUNTIME_MARKERS),
  ...PROVIDER_GATEWAYS.map((gateway) => `gateway:${gateway.id}`),
  // A bare OpenAI-compatible endpoint with no local daemon and no gateway row
  // behind it — the "separate remote API" case in the design record.
  'api',
]);

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
 * Why this backend cannot be created, or `null`.
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

/** Default wall clock for a record no recipe times — every shipped `api` sample. */
const API_ROUTE_TIMEOUT_MS = 300000;

/**
 * The executable defaults supplied before saved selection and route overrides.
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
 * The record markers a materialized route on a service definition must carry,
 * so the spawner and `providerConnectionProfile` classify it onto that service:
 * the runtime's `*Backed` boolean, or `gatewayBacked: '<id>'`. Slotstream and
 * a plain API endpoint carry none, exactly as {@link connectionKindMarkers}.
 *
 * Written unconditionally, including onto a direct `type: 'api'` record — the
 * round-trip contract `materializeRoute` owes (`routeDescribesService`) needs
 * it there too: `localRuntimeKind`'s id/port fallback only covers `ollama` /
 * `lmstudio` (by id, name or default port) and `mtplx` (by id alone, and only
 * when the record's id is literally `mtplx`), never `llama` / `vllm` /
 * `sglang`, and a freshly minted direct record's id is `direct.api@<slug>`,
 * not the shipped sample's own id. A direct API preset's DRIFT check is what
 * ignores this marker instead (`derivedPresetDrift`, #8159) — the shipped
 * `ollama` / `lmstudio` / `mtplx` samples predate the graph and never carried
 * one, but nothing on the direct API path reads it either way.
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
 * Compose the executable record for a harness, method and service using the
 * first compatible binding (#7562).
 *
 * Given a harness row (or id), the execution method, a service instance (see
 * `resolveServiceInstance`), an optional credential-bootstrap app, and the
 * model/effort selection, it writes every value the binding says the program
 * reads — base URL, credential, static env, backend markers, inline
 * OpenCode/Pi selection — plus the recipe's per-mode argv, so the result is a
 * complete `data/providers.json` record with no further lookup. Feeding it
 * back through `providerConnectionProfile` classifies it onto the same
 * service ({@link routeDescribesService}).
 *
 * Pure: no I/O, no clock, no spawn. Throws a typed error (`err.code`) rather
 * than minting a route that cannot run:
 *   - `HARNESS_UNKNOWN` / `HARNESS_METHOD_UNSUPPORTED`
 *   - `HARNESS_SERVICE_INCOMPATIBLE` — no binding reaches this service
 *   - `SERVICE_ENDPOINT_REQUIRED` — the binding needs a base URL the instance
 *     does not declare (a local daemon's port is an install-specific fact)
 *   - `SERVICE_CREDENTIAL_REQUIRED` — the program refuses to start without one
 *     (a binding's `optionalOnPlans` names the plans it starts keyless on)
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
 * Where a binding points its program: the env var, inline config or CLI flag
 * that carries the service's base URL, and the `endpoint` the record keeps.
 * `{ error }` when the binding needs a base URL the instance does not declare.
 */
function resolveRouteEndpoint(binding, instance, definition) {
  const protocol = binding.protocol || null;
  const baseUrl = protocol ? instance.transports[protocol]?.baseUrl ?? null : null;
  if (protocol && !baseUrl) {
    return { error: serviceError('SERVICE_ENDPOINT_REQUIRED', `${definition.label} declares no ${protocol} endpoint; set its base URL first.`) };
  }
  const env = {};
  const args = [];
  switch (binding.baseUrl?.via) {
    case 'env': env[binding.baseUrl.name] = baseUrl; break;
    case 'opencodeConfig':
      env.OPENCODE_CONFIG_CONTENT = opencodeProviderConfig({
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
  return { env, args, endpoint };
}

/**
 * How a binding hands the program its key: `via` (`field` / `env` /
 * `gatewayEnv`), the env var it lands under, and whether the program refuses
 * to start without one. A bootstrap-credentialed instance is never "required"
 * (its key is minted at spawn), nor is a plan the binding starts keyless on.
 */
function resolveRouteCredential(binding, instance, definition) {
  const credential = binding.credential || null;
  // A `gatewayEnv` credential lands under the gateway's own variable (what the
  // spawner exports for OpenCode); on a service that is not a gateway it lands
  // on the record's `apiKey`, which the inline-config builder attaches at spawn.
  const via = credential?.via === 'gatewayEnv' && !definition.gateway ? 'field' : credential?.via;
  const envName = via === 'gatewayEnv'
    ? definition.gateway.apiKeyEnv
    : via === 'env' ? credential.name ?? definition.credential.envVars[0] ?? null : null;
  const required = credential?.required === true && instance.credentialVia !== 'bootstrap'
    && !credential.optionalOnPlans?.includes(instance.plan);
  return { via, envName, required };
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
  const apiKey = typeof instance.credentials.apiKey === 'string' ? instance.credentials.apiKey : '';
  const { error: endpointError, env: endpointEnv, args: endpointArgs, endpoint } = resolveRouteEndpoint(binding, instance, definition);
  if (endpointError) return { record: null, error: endpointError };
  const credential = resolveRouteCredential(binding, instance, definition);
  if (credential.required && apiKey === '') {
    return refuse('SERVICE_CREDENTIAL_REQUIRED',
      `${harness.label} will not start without a ${credential.envName || 'key'} for ${definition.label}. Set one first — any non-empty value works for a local daemon that ignores it.`);
  }

  const envVars = { ...endpointEnv };
  const secretEnvVars = [];
  const fields = endpoint ? { endpoint } : {};
  const args = [...(recipe?.modes?.[method]?.args || []), ...endpointArgs];
  if (credential.via === 'field') fields.apiKey = apiKey;
  // A required key is already refused above when empty, so a set key is the only export case.
  if (credential.envName && apiKey !== '') {
    envVars[credential.envName] = apiKey;
    secretEnvVars.push(credential.envName);
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
      ...(bootstrap.envCommand ? { envCommand: [...bootstrap.envCommand] } : {}),
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
