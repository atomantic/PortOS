/**
 * The hosted OpenAI-compatible gateways an OpenCode CLI/TUI wrapper can front-end,
 * and which one a given provider record is marked as fronting.
 *
 * Browser MIRROR of `server/lib/providerGateways.js` (and its vendored twin
 * `server/lib/aiToolkit/internal/gateways.js`) — the browser cannot import server
 * code, so the registry is duplicated and `server/lib/providerGateways.parity.test.js`
 * reads this file as TEXT to pin the copies together.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

/**
 * The hosted OpenAI-compatible gateways an OpenCode CLI/TUI wrapper can
 * front-end. MIRROR of `PROVIDER_GATEWAYS` in `server/lib/providerGateways.js`
 * (and its vendored twin `server/lib/aiToolkit/internal/gateways.js`) — the
 * browser cannot import server code, so the table is duplicated; keep the three
 * in lockstep (server/lib/providerGateways.parity.test.js pins this copy's
 * `id`/`label`/`apiKeyEnv`/`legacyMarker` rows against the server registry). `id` is simultaneously the OpenCode namespace, the
 * `gatewayBacked` marker value, and the id of the sibling `api` record that
 * owns the key.
 */
export const PROVIDER_GATEWAYS = Object.freeze([
  Object.freeze({ id: 'orcarouter', label: 'OrcaRouter', apiKeyEnv: 'ORCAROUTER_API_KEY', legacyMarker: 'orcarouterBacked' }),
  Object.freeze({ id: 'openrouter', label: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY' }),
]);

/**
 * The gateway an OpenCode wrapper front-ends, or null (the shipped
 * `opencode-<gateway>` / `-tui` presets, or any renamed wrapper carrying the
 * marker).
 *
 * These wrappers deliberately carry NO key of their own: at spawn time the
 * server attaches the key from the sibling API provider whose id equals the
 * gateway id (`server/lib/aiToolkit/providers.js` `withGatewayApiKey`), so the
 * one place a user actually pastes the key is that API provider, not this form.
 * Reads the generic `gatewayBacked` marker first, then the legacy per-gateway
 * boolean — MIRROR of `gatewayForProvider` on the server; keep in lockstep with
 * `server/lib/providerModels.js#getOpencodeLocalProviderNamespace`.
 * @param {{id?:string,gatewayBacked?:string,orcarouterBacked?:boolean}|null|undefined} provider
 */
export const gatewayForProvider = (provider) => {
  if (!provider || typeof provider !== 'object') return null;
  const declared = PROVIDER_GATEWAYS.find((g) => g.id === provider.gatewayBacked);
  if (declared) return declared;
  return PROVIDER_GATEWAYS.find((g) => g.legacyMarker && provider[g.legacyMarker] === true) || null;
};

/** True when a provider is an OpenCode wrapper front-ending any hosted gateway. */
export const isGatewayBackedProvider = (provider) => gatewayForProvider(provider) !== null;
