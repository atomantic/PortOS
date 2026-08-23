/**
 * Hosted OpenAI-compatible gateways an OpenCode CLI/TUI wrapper can front-end
 * (OrcaRouter, OpenRouter).
 *
 * A DELIBERATE MIRROR of `server/lib/providerGateways.js`. This directory is
 * vendored and stays self-contained — no imports out to other PortOS modules
 * (see `aiToolkit/CLAUDE.md`) — so the table is duplicated rather than imported.
 * `server/lib/providerGateways.parity.test.js` fails when the two drift.
 *
 * Lives in `internal/` for the same reason `ollamaBacked.js` does: the
 * model-fetcher table (`internal/modelFetchers.js`) keys a row on it, and an
 * import back into `providers.js` would form a module cycle. Re-exported from
 * `providers.js` so hosts classify a wrapper the same way the refresh dispatch
 * and the sibling-key attach do.
 *
 * What makes a gateway different from a local runtime (`ollamaBacked`,
 * `vllmBacked`, …): it is remote (nothing to probe), it always authenticates,
 * and the wrapper stores NO key — the sibling `api` record whose id equals the
 * gateway id owns it (`withGatewayApiKey` in `providers.js`).
 */

/** @type {readonly {id:string,label:string,baseURL:string,apiKeyEnv:string,legacyMarker?:string,legacyApiKeyField?:string}[]} */
export const PROVIDER_GATEWAYS = Object.freeze([
  Object.freeze({
    id: 'orcarouter',
    label: 'OrcaRouter',
    baseURL: 'https://api.orcarouter.ai/v1',
    apiKeyEnv: 'ORCAROUTER_API_KEY',
    legacyMarker: 'orcarouterBacked',
    legacyApiKeyField: 'orcarouterApiKey',
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  }),
]);

/** Every gateway id. */
export const PROVIDER_GATEWAY_IDS = Object.freeze(PROVIDER_GATEWAYS.map((g) => g.id));

/** The registry row for a gateway id, or `null` for anything else. */
export const gatewayById = (id) => PROVIDER_GATEWAYS.find((g) => g.id === id) || null;

/**
 * The gateway a provider record opts into, or `null`.
 *
 * Reads the generic `gatewayBacked: '<id>'` marker first, then each row's
 * legacy per-gateway boolean (`orcarouterBacked`) — records predating the
 * registry keep resolving, forever, with no migration.
 */
export function gatewayForProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const declared = gatewayById(provider.gatewayBacked);
  if (declared) return declared;
  return PROVIDER_GATEWAYS.find((g) => g.legacyMarker && provider[g.legacyMarker] === true) || null;
}

/** True when this provider is an OpenCode wrapper front-ending any gateway. */
export const isGatewayBackedProvider = (provider) => gatewayForProvider(provider) !== null;
