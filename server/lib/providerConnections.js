import { isDeepStrictEqual } from 'node:util';
import { localRuntimeKind, normalizeOpenAiBaseUrl } from './localProviderRuntime.js';
import { PROVIDER_GATEWAYS, gatewayIdForProvider } from './providerGateways.js';
import { harnessForProvider } from './providerHarnesses.js';
import {
  getOpencodeLocalProviderNamespace,
  isOpencodeCommand,
  parseOpencodeConfigContent,
} from './providerModels.js';

/**
 * The CONNECTION half of the provider-connection graph proposed in
 * `docs/plans/2026-09-06-provider-connections-and-harnesses.md` (#6366).
 *
 * A connection is the backend a harness talks to: its wire protocol, its base
 * URL, and the credential material that reaches it. This module is the pure
 * adapter that reads one existing provider record and answers what connection
 * it describes — nothing here opens a socket, spawns a process, or writes a
 * file, because the import preview must be able to run at boot and on every
 * page render without touching an AI provider.
 *
 * IDENTITY RULES (from the decision record, and the reason this is one module
 * rather than an inline comparison at each call site):
 *
 *   - An endpoint string alone is NOT identity. Scheme, host, port, path,
 *     protocol adapter and credential material all participate.
 *   - Equal vendor names, display names, catalogs, `hasCredentials` booleans or
 *     REDACTED secrets never establish equivalence. {@link sameConnectionIdentity}
 *     compares real server-side values and refuses outright once a value has
 *     been redacted, so a sanitized record can never merge two connections.
 *   - Never resolve DNS, never equate loopback with a remote name, and never
 *     strip an arbitrary URL path. The one normalization allowed is the
 *     RECOGNIZED OpenAI-compatible `/v1` suffix, and only between two records
 *     already known to front the same local-runtime kind — an adapter
 *     operation, not generic URL trimming.
 */

/** Why a provider record cannot be mapped into the graph and stays a legacy route. */
export const CONNECTION_ISOLATION_REASONS = Object.freeze([
  'unknown-harness',
  'unknown-endpoint',
  'dynamic-config',
  'external-harness-config',
  'unparsable-harness-config',
  'foreign-namespace-config',
  'redacted-credential',
  'sibling-configuration-mismatch',
]);

/** Wire protocols a connection transport can speak. */
export const CONNECTION_PROTOCOLS = Object.freeze(['anthropic', 'openai', 'native']);

/**
 * Env vars that carry a connection's BASE URL rather than harness behavior.
 * Everything not listed here stays route-owned, so a harness-specific var like
 * `ANTHROPIC_SMALL_FAST_MODEL` is never materialized out of a connection.
 */
const TRANSPORT_ENV_VARS = Object.freeze({
  ANTHROPIC_BASE_URL: 'anthropic',
  OPENAI_BASE_URL: 'openai',
});

/**
 * Env vars that carry connection CREDENTIALS, including each gateway's key var.
 *
 * Exported because it is also the set a freshly MINTED route may materialize a
 * connection's credentials into (`providerRouteRecipes.js`): an env var outside
 * this list is not read back as a credential here, so writing one would make a
 * new route describe a connection it is not actually on.
 */
export const CONNECTION_CREDENTIAL_ENV_VARS = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  ...PROVIDER_GATEWAYS.map((gateway) => gateway.apiKeyEnv),
]);

/**
 * The value `server/routes/providers.js` substitutes for a secret on the way
 * out. A profile carrying it was built from a SANITIZED record, which can never
 * be trusted to prove two connections are the same.
 */
export const REDACTED_CREDENTIAL = '***';

/** A `${VAR}` / `$VAR` / `$(cmd)` reference — resolved at spawn time, not here. */
const DYNAMIC_REFERENCE_RE = /\$[({]?[A-Za-z_]/;

/** Flags that point a harness at an external config file we cannot read here. */
const EXTERNAL_CONFIG_FLAGS = new Set(['--config', '--config-file', '--configuration']);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The base URL an OpenCode record declares for `namespace` inside its inline
 * config, plus every OTHER namespace it declares. A config naming a namespace
 * the record has no marker for is one this adapter cannot fully understand, and
 * the decision record says such a record stays isolated rather than guessing.
 */
function opencodeDeclaredEndpoints(provider, namespace) {
  const raw = provider?.envVars?.OPENCODE_CONFIG_CONTENT;
  if (!isNonEmptyString(raw)) return { baseUrl: null, foreign: [], unparsable: false, declared: false };
  const parsed = parseOpencodeConfigContent(raw);
  if (!parsed) return { baseUrl: null, foreign: [], unparsable: true, declared: true };
  const declaredProviders = parsed.provider && typeof parsed.provider === 'object' ? parsed.provider : {};
  const baseUrl = declaredProviders?.[namespace]?.options?.baseURL;
  return {
    baseUrl: isNonEmptyString(baseUrl) ? baseUrl : null,
    foreign: Object.keys(declaredProviders).filter((key) => key !== namespace),
    unparsable: false,
    declared: true,
  };
}

/** The backend kind a record fronts. Markers and ids first, never a guess from auth. */
function connectionKind(provider) {
  const runtime = localRuntimeKind(provider);
  if (runtime) return runtime;
  const gateway = gatewayIdForProvider(provider);
  if (gateway) return `gateway:${gateway}`;
  return provider?.type === 'api' ? 'api' : 'vendor';
}

/**
 * Read one provider record as the connection it describes.
 *
 * The returned `credentials` map holds RAW server-side secret material: it
 * exists so identity can be decided honestly, and it must never be serialized
 * into a response, a log line, or a preview DTO.
 *
 * `owned` names exactly the record keys this connection would own, so the
 * executable record can be split and re-materialized losslessly — see
 * {@link withoutConnectionOwnedFields} / {@link withConnectionOwnedFields}.
 *
 * @param {object|null|undefined} provider
 * @returns {{kind:string, protocol:string, transports:object, credentials:object,
 *            owned:{fields:object, envVars:object, hasEnvVars:boolean}, reasons:{code:string,detail:string}[]}}
 */
export function providerConnectionProfile(provider) {
  const reasons = [];
  const addReason = (code, detail) => reasons.push({ code, detail });

  const record = provider && typeof provider === 'object' ? provider : {};
  const envVars = record.envVars && typeof record.envVars === 'object' ? record.envVars : {};
  const hasEnvVars = Object.hasOwn(record, 'envVars');
  const harness = harnessForProvider(record);
  const kind = connectionKind(record);
  const namespace = getOpencodeLocalProviderNamespace(record);

  if (record.type !== 'api' && !harness) addReason('unknown-harness', String(record.command || record.type || ''));

  // --- transport ------------------------------------------------------------
  const ownedFields = {};
  const ownedEnvVars = {};
  const transports = {};
  let protocol = harness?.protocol || 'openai';
  let baseUrl = null;

  if (isOpencodeCommand(record.command) && namespace) {
    // OpenCode's inline config is BOTH transport and harness behavior
    // (permissions, agents, generation defaults). Splitting that JSON string
    // would be lossy, so it stays route-owned and the connection only derives
    // its endpoint from it — the binding-level "harness-specific transport
    // configuration" the decision record allows.
    const declared = opencodeDeclaredEndpoints(record, namespace);
    if (declared.unparsable) addReason('unparsable-harness-config', 'OPENCODE_CONFIG_CONTENT');
    if (declared.foreign.length > 0) addReason('foreign-namespace-config', declared.foreign.join(','));
    protocol = 'openai';
    baseUrl = declared.baseUrl;
  } else {
    // `endpoint` is connection-owned whenever the key exists — including when it
    // is null/empty — so the split below stays lossless either way.
    if (Object.hasOwn(record, 'endpoint')) ownedFields.endpoint = record.endpoint;
    for (const [name, envProtocol] of Object.entries(TRANSPORT_ENV_VARS)) {
      if (!isNonEmptyString(envVars[name])) continue;
      ownedEnvVars[name] = envVars[name];
      protocol = envProtocol;
      baseUrl = envVars[name];
      break;
    }
    if (!baseUrl && isNonEmptyString(record.endpoint)) baseUrl = record.endpoint;
  }

  if (baseUrl) transports[protocol] = { baseUrl };

  // A record fronting a local daemon or a bare API endpoint MUST name where it
  // is. Falling back to a conventional default here would silently equate two
  // installs' different daemons, so an undeclared endpoint isolates instead.
  const needsEndpoint = Boolean(localRuntimeKind(record)) || record.type === 'api';
  if (needsEndpoint && !baseUrl) addReason('unknown-endpoint', kind);

  // --- credentials ----------------------------------------------------------
  const credentials = {};
  if (Object.hasOwn(record, 'apiKey')) {
    ownedFields.apiKey = record.apiKey;
    if (isNonEmptyString(record.apiKey)) credentials.apiKey = record.apiKey;
  }
  for (const name of CONNECTION_CREDENTIAL_ENV_VARS) {
    if (!Object.hasOwn(envVars, name)) continue;
    ownedEnvVars[name] = envVars[name];
    if (isNonEmptyString(envVars[name])) credentials[name] = envVars[name];
  }
  if (Object.values(credentials).includes(REDACTED_CREDENTIAL)) {
    addReason('redacted-credential', 'profile built from a sanitized record');
  }

  // --- configuration this adapter cannot fully understand --------------------
  const dynamic = [
    ...Object.entries(ownedEnvVars),
    ...Object.entries(ownedFields),
  ].filter(([, value]) => typeof value === 'string' && DYNAMIC_REFERENCE_RE.test(value));
  if (dynamic.length > 0) addReason('dynamic-config', dynamic.map(([name]) => name).join(','));

  const externalConfig = [
    ...Object.keys(envVars).filter((name) => /_CONFIG(_FILE)?$/.test(name) && isNonEmptyString(envVars[name])),
    ...(Array.isArray(record.args) ? record.args.filter((arg) => EXTERNAL_CONFIG_FLAGS.has(arg)) : []),
  ];
  if (externalConfig.length > 0) addReason('external-harness-config', externalConfig.join(','));

  return {
    kind,
    protocol,
    transports,
    credentials,
    owned: { fields: ownedFields, envVars: ownedEnvVars, hasEnvVars },
    reasons,
  };
}

/**
 * The executable record with its connection-owned values removed — the half a
 * route row would store once the connection owns the rest.
 */
export function withoutConnectionOwnedFields(provider, owned) {
  const rest = { ...provider };
  for (const key of Object.keys(owned.fields)) delete rest[key];
  if (owned.hasEnvVars) {
    rest.envVars = Object.fromEntries(
      Object.entries(provider.envVars || {}).filter(([name]) => !Object.hasOwn(owned.envVars, name)),
    );
  }
  return rest;
}

/**
 * Materialize connection-owned values back into an executable record.
 *
 * This is the COMPATIBILITY contract, not a convenience: a downgraded install
 * runs `data/providers.json` with no graph at all, so every connection-owned
 * value has to live in the executable record too. Round-tripping a record
 * through {@link withoutConnectionOwnedFields} and back must reproduce it
 * exactly, unknown custom fields included.
 */
export function withConnectionOwnedFields(routeRecord, owned) {
  const merged = { ...routeRecord, ...owned.fields };
  // `Object.assign` rather than an object spread here: the spawn-site guard in
  // `cliChildEnv.test.js` reads a spread of a record's env map beside an
  // `envVars:` key as a hand-rolled CLI child environment, and this module can
  // never spawn anything. Same result, no false positive to exempt.
  if (owned.hasEnvVars) merged.envVars = Object.assign({}, routeRecord.envVars, owned.envVars);
  return merged;
}

/**
 * The connection-owned snapshot a route should carry once bound to
 * `connection`: the record's own owned KEY SET (so the split stays lossless for
 * this record's shape) filled with the connection's values. Uses the same
 * protocol and env ownership rules as the reader above; the graph service owns
 * only staging, writing and acknowledging this snapshot. Route-owned inline
 * configuration and unknown fields remain outside the projection.
 */
export function projectConnectionOwnedFields(provider, connection) {
  const { owned, protocol } = providerConnectionProfile(provider);
  // Read and project through the same protocol classification. Map insertion
  // order must not send an OpenAI endpoint to a connection's Anthropic wire.
  // Retain the legacy fallback for connections declaring only another wire.
  const baseUrl = connection.transports[protocol]?.baseUrl
    ?? Object.values(connection.transports)[0]?.baseUrl ?? null;
  const fields = { ...owned.fields };
  if (Object.hasOwn(fields, 'endpoint') && baseUrl !== null) fields.endpoint = baseUrl;
  if (Object.hasOwn(fields, 'apiKey')) fields.apiKey = connection.credentials.apiKey ?? fields.apiKey;
  const envVars = { ...owned.envVars };
  for (const name of Object.keys(envVars)) {
    if (Object.hasOwn(connection.credentials, name)) {
      envVars[name] = connection.credentials[name];
      continue;
    }
    // `ANTHROPIC_BASE_URL` names the anthropic transport, not merely "a URL":
    // a connection that speaks several protocols has a different base URL for
    // each, and picking the first would point the harness at the wrong port.
    const envProtocol = TRANSPORT_ENV_VARS[name];
    const url = envProtocol ? connection.transports[envProtocol]?.baseUrl ?? baseUrl : null;
    if (url) envVars[name] = url;
  }
  return { fields, envVars, hasEnvVars: owned.hasEnvVars };
}

/**
 * A stable, SECRET-FREE bucket key. Two profiles can only be the same
 * connection if their keys match — but a matching key is not sufficient, which
 * is why {@link sameConnectionIdentity} still compares real credentials.
 */
export const connectionBucketKey = (harnessId, profile) => JSON.stringify([
  harnessId ?? null,
  profile.kind,
  Object.entries(profile.transports).sort(([a], [b]) => a.localeCompare(b)),
]);

/**
 * Whether two profiles describe the SAME backend connection.
 *
 * Compares actual server-side credential values; a redacted value can never
 * satisfy it, so a sanitized record cannot merge two distinct connections.
 */
export function sameConnectionIdentity(a, b) {
  if (!a || !b) return false;
  const values = [...Object.values(a.credentials), ...Object.values(b.credentials)];
  if (values.includes(REDACTED_CREDENTIAL)) return false;
  return a.kind === b.kind
    && isDeepStrictEqual(a.transports, b.transports)
    && isDeepStrictEqual(a.credentials, b.credentials);
}

/**
 * Whether two profiles reach the same backend endpoint, and how they differ.
 *
 * This is the only basis on which the preview may SUGGEST a cross-harness link
 * — it never performs one. A suggestion is deliberately looser than
 * {@link sameConnectionIdentity}: two harnesses commonly reach one daemon
 * through different protocol adapters and different auth (Claude Code sends an
 * Anthropic token to Ollama's Anthropic-compatible port; OpenCode sends none to
 * its `/v1` port). Those differences are what a human confirms at link time, so
 * they are REPORTED rather than used to suppress the suggestion.
 *
 * The `/v1` reconciliation is applied only when both records front the same
 * recognized local-runtime kind, where the OpenAI-compatible suffix is a known
 * property of that backend. Anything else compares the URLs verbatim — no DNS
 * resolution, no loopback/remote equivalence, no arbitrary path trimming.
 *
 * @returns {{sameEndpoint:boolean, differences:string[]}}
 */
export function compareBackendEndpoints(a, b) {
  const none = { sameEndpoint: false, differences: [] };
  if (!a || !b || a.kind !== b.kind) return none;
  const urls = [a, b].map((profile) => Object.values(profile.transports)[0]?.baseUrl || null);
  if (urls.some((url) => !url)) return none;
  const [left, right] = a.kind.startsWith('gateway:') || a.kind === 'vendor'
    ? urls
    : urls.map((url) => normalizeOpenAiBaseUrl(url));
  if (left !== right) return none;

  const differences = [];
  if (a.protocol !== b.protocol) differences.push('protocol');
  if ([...Object.values(a.credentials), ...Object.values(b.credentials)].includes(REDACTED_CREDENTIAL)) {
    differences.push('credentials-unknown');
  } else if (!isDeepStrictEqual(a.credentials, b.credentials)) {
    differences.push('credentials');
  }
  return { sameEndpoint: true, differences };
}
