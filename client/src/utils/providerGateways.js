/**
 * The hosted OpenAI-compatible gateways an OpenCode CLI/TUI wrapper can front-end,
 * and which one a given provider record is marked as fronting.
 *
 * The registry and its predicates are re-exported from the pure leaf
 * `server/lib/providerGateways.js`. Each row's `id` is simultaneously the
 * OpenCode namespace, the `gatewayBacked` marker value, and the id of the
 * sibling `api` record that owns the key; the wrappers themselves deliberately
 * carry NO key (`server/lib/aiToolkit/providers.js` `withGatewayApiKey`
 * attaches the sibling's at spawn time), so the one place a user pastes it is
 * that API provider, not the wrapper form.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

export { PROVIDER_GATEWAYS, gatewayForProvider, isGatewayBackedProvider } from '../../../server/lib/providerGateways.js';
