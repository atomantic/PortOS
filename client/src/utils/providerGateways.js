/**
 * The hosted OpenAI-compatible gateways an OpenCode CLI/TUI wrapper can front-end,
 * and which one a given provider record is marked as fronting.
 *
 * `PROVIDER_GATEWAYS` / `gatewayById` / `gatewayForProvider` / `isGatewayBackedProvider` — the hosted
 * OpenAI-compatible gateways (`orcarouter`, `openrouter`, `nvidia-nim`) an OpenCode CLI/TUI wrapper
 * can front-end, inheriting its API key at spawn time from the sibling API provider whose id equals
 * the gateway id. Reads the generic `gatewayBacked` marker and, forever, the legacy per-gateway
 * boolean. Rows with a stable vendor key page also carry `keyUrl`, rendered as the card's "get a key"
 * link while the key is missing. All four are re-exported from the pure leaf
 * `server/lib/provider/providerGateways.js`.
 *
 * The registry and its predicates are re-exported from the pure leaf
 * `server/lib/provider/providerGateways.js`. Each row's `id` is simultaneously the
 * OpenCode namespace, the `gatewayBacked` marker value, and the id of the
 * sibling `api` record that owns the key; the wrappers themselves deliberately
 * carry NO key (`server/lib/aiToolkit/providers.js` `withGatewayApiKey`
 * attaches the sibling's at spawn time), so the one place a user pastes it is
 * that API provider, not the wrapper form.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

export { PROVIDER_GATEWAYS, gatewayById, gatewayForProvider, isGatewayBackedProvider } from '../../../server/lib/provider/providerGateways.js';
