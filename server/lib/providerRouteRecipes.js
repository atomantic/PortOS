import { CONNECTION_CREDENTIAL_ENV_VARS, CONNECTION_PROTOCOLS } from './providerConnections.js';
import { PROVIDER_GATEWAYS } from './providerGateways.js';
import { CREATABLE_HARNESS_IDS, harnessById, harnessRecipe } from './providerHarnesses.js';
import { LOCAL_RUNTIMES } from './localProviderRuntime.js';

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
export function bindingBlocker({ harnessId, modes, connection }) {
  if (harnessId !== null && !CREATABLE_HARNESS_IDS.includes(harnessId)) {
    return {
      code: 'PROVIDER_HARNESS_NOT_CREATABLE',
      message: `${harnessById(harnessId)?.label || harnessId} reaches only its own vendor service, so it cannot be pointed at a backend connection. Add it from the provider editor instead.`,
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

/** OpenCode's inline provider declaration for one namespace and base URL. */
const opencodeConfigContent = (kind, baseUrl) => JSON.stringify({
  permission: 'allow',
  provider: {
    [opencodeNamespace(kind)]: {
      npm: '@ai-sdk/openai-compatible',
      name: connectionKindLabel(kind),
      options: { baseURL: baseUrl },
    },
  },
});

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

  if (recipe?.baseUrl.via === 'env') envVars[recipe.baseUrl.name] = baseUrl;
  if (recipe?.baseUrl.via === 'opencodeConfig') {
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
  if (recipe?.credential.via === 'env' && !Object.hasOwn(envVars, recipe.credential.name)) {
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
    ...(recipe ? { command: recipe.command, timeout: recipe.timeout } : { timeout: 300000 }),
    ...(recipe ? recipe.modes[mode] : {}),
    models: [],
    defaultModel: null,
    enabled: false,
    envVars,
    secretEnvVars,
  };
}

/**
 * Route ids for a new binding's modes: readable, stable and free.
 *
 * The TUI id is the CLI id plus `-tui` because that is the pairing
 * `providerModeGroups` recognizes — mint them any other way and the toolkit
 * stops treating the two modes as one harness on one backend. The whole set is
 * suffixed together for the same reason: uniquifying each id on its own would
 * break the stem relationship the moment one half collided.
 *
 * @param {{harnessId:string|null, kind:string, modes:string[], taken:Set<string>}} input
 * @returns {Record<string,string>} mode → provider id
 */
export function mintRouteIds({ harnessId, kind, modes, taken }) {
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stem = [harnessId, kind].filter(Boolean).map(slug).join('-') || 'route';
  const idsFor = (base) => Object.fromEntries(modes.map((mode) => [mode, mode === 'tui' ? `${base}-tui` : base]));

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const ids = idsFor(suffix === 0 ? stem : `${stem}-${suffix + 1}`);
    if (Object.values(ids).every((id) => !taken.has(id))) return ids;
  }
  // Unreachable with any realistic install; a bounded loop beats an unbounded
  // one, and an explicit throw beats returning a colliding id.
  throw new Error(`Could not mint a free route id for ${stem}`);
}
