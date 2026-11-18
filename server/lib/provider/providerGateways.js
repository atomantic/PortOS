/**
 * `PROVIDER_GATEWAYS`: one row per hosted OpenAI-compatible gateway an OpenCode CLI/TUI wrapper can front-end (OrcaRouter, OpenRouter, NVIDIA NIM).
 *
 * OrcaRouter was once *the* gateway (a boolean `orcarouterBacked` and literal id hand-copied across ~15 files), and a second gateway that way would double a copy-paste axis (the pressure `providerVendors.js` relieved, #3618); every dispatch site now asks this registry. A gateway differs from a *local runtime* (`ollamaBacked`, `vllmBacked`, `sglangBacked`, …): it is REMOTE (no daemon to probe; `localRuntimeKind` and `isLocalBackedClaude` exclude it), it always AUTHENTICATES and the wrapper stores no key (the sibling API record with the same id owns it), and its upstream models own their reasoning switch (`THINKING_STYLE[<gateway>] === null`). Dependency-light like `providerVendors.js` / `cliProviderArgs.js`: it imports only the leaf `serviceDefinitions.js`, so it stays importable from `providerModels.js` (pulled by the standalone autofixer process). **Two copies of this table exist by architecture and must stay in lockstep:** this file, and `aiToolkit/internal/gateways.js` (the vendored toolkit may not import out; see `aiToolkit/AGENTS.md`); `providerGateways.parity.test.js` fails on drift. The browser is not a third: `client/src/utils/providerGateways.js` re-exports this pure leaf.
 */

import { SERVICE_DEFINITIONS } from '../serviceDefinitions.js';

/**
 * @typedef {object} ProviderGateway
 * @property {string} id — the OpenCode provider namespace, the `gatewayBacked` marker value, AND the id of the sibling `api` record holding the key (one string for all three: the sibling lookup is `providers[gateway.id]`).
 * @property {string} [keyUrl] — where to obtain an API key, rendered as a "get a key" link while the key is missing (only gateways with a stable vendor key page).
 * @property {string} [legacyMarker] — the pre-registry boolean field (`orcarouterBacked`); records written before `gatewayBacked` carry it and installs upgrade on their own schedule, so it is read FOREVER (no migration rewrites records).
 * @property {string} [legacyApiKeyField] — a pre-registry alias for the wrapper's own key field.
 */

/**
 * @type {readonly ProviderGateway[]}
 * DERIVED from the service definitions carrying a `gateway` column (`serviceDefinitions.js`, #7562): a gateway is a service a harness can be pointed at. The projection keeps this row shape byte-for-byte so consumers and the toolkit mirror are untouched.
 */
export const PROVIDER_GATEWAYS = Object.freeze(SERVICE_DEFINITIONS
  .filter((service) => service.gateway)
  .map((service) => Object.freeze({
    id: service.id,
    label: service.label,
    baseURL: service.transports.openai.defaultBaseUrl,
    apiKeyEnv: service.gateway.apiKeyEnv,
    ...(service.credential.keyUrl ? { keyUrl: service.credential.keyUrl } : {}),
    ...(service.gateway.legacyMarker ? { legacyMarker: service.gateway.legacyMarker } : {}),
    ...(service.gateway.legacyApiKeyField ? { legacyApiKeyField: service.gateway.legacyApiKeyField } : {}),
  })));

/** Every gateway id — the namespace key space `opencodeConfig.js` extends. */
export const PROVIDER_GATEWAY_IDS = Object.freeze(PROVIDER_GATEWAYS.map((g) => g.id));

export const gatewayById = (id) => PROVIDER_GATEWAYS.find((g) => g.id === id) || null;

export const isGatewayNamespace = (namespace) => PROVIDER_GATEWAY_IDS.includes(namespace);

/**
 * The gateway a provider record opts into, or `null`: the generic `gatewayBacked: '<id>'` marker first, then each row's `legacyMarker` boolean (so pre-registry records resolve identically with no migration);
 * registry order breaks a tie on a malformed record carrying two markers, preserving the legacy if-chain outcome.
 */
export function gatewayForProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const declared = gatewayById(provider.gatewayBacked);
  if (declared) return declared;
  return PROVIDER_GATEWAYS.find((g) => g.legacyMarker && provider[g.legacyMarker] === true) || null;
}

/** `gatewayForProvider`, reduced to the id (which is also the OpenCode namespace). */
export const gatewayIdForProvider = (provider) => gatewayForProvider(provider)?.id ?? null;

/** True when a provider is an OpenCode wrapper front-ending any hosted gateway. */
export const isGatewayBackedProvider = (provider) => gatewayForProvider(provider) !== null;

/**
 * Attach a gateway-backed wrapper's sibling API key for execution, from an already-loaded provider collection. The synchronous twin of `withGatewayApiKey` in `lib/aiToolkit/providers.js` (live store): `getAllProviders` returns RAW records with
 * no inherited key, so a fallback pick from such a map would execute with no Authorization header (NVIDIA NIM 401s). Same contract: the key lands as a NON-ENUMERABLE property so it never persists, leaks into responses, or survives a
 * spread/JSON round-trip (cloners must re-carry it: see `providerForRun` in `services/promptRunner.js`). Pure: returns the input untouched when nothing to attach (not gateway-backed, own key set, or sibling keyless/missing).
 *
 */
export function attachGatewaySiblingKey(provider, providers) {
  if (!provider || typeof provider !== 'object' || provider.apiKey) return provider;
  const gateway = gatewayForProvider(provider);
  if (!gateway) return provider;
  const siblings = Array.isArray(providers) ? providers : Object.values(providers || {});
  const siblingKey = siblings.find((entry) => entry?.id === gateway.id)?.apiKey || null;
  if (!siblingKey) return provider;
  const armed = { ...provider };
  Object.defineProperty(armed, 'apiKey', { value: siblingKey, enumerable: false, configurable: true });
  return armed;
}
