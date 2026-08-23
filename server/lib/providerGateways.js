/**
 * `PROVIDER_GATEWAYS` — one row per hosted OpenAI-compatible gateway an OpenCode
 * CLI/TUI wrapper can front-end (OrcaRouter, OpenRouter).
 *
 * Before this file, OrcaRouter wasn't *a* gateway — it was *the* gateway: the
 * boolean `orcarouterBacked` and the literal id `'orcarouter'` were hand-copied
 * across ~15 server and client files (namespace resolution, the OpenCode config
 * builder, both zod schemas, the model-fetcher table, the sibling-key attach,
 * the prerequisite check, and the two "this is NOT a local runtime" carve-outs).
 * Adding a second gateway that way would have doubled a copy-paste axis — the
 * same pressure `providerVendors.js` was created to relieve (#3618). Every
 * dispatch site now asks this registry instead.
 *
 * A gateway is distinct from a *local runtime* (`ollamaBacked`, `vllmBacked`,
 * `sglangBacked`, …) in three ways every consumer keys on:
 *   - it is REMOTE, so there is no daemon to probe (`localRuntimeKind` and
 *     `isLocalBackedClaude` both exclude it);
 *   - it always AUTHENTICATES, and the wrapper deliberately stores no key — the
 *     sibling API record with the same id as the gateway owns it;
 *   - its upstream models own their own reasoning switch, so it exposes no
 *     thinking toggle (`THINKING_STYLE[<gateway>] === null`).
 *
 * Dependency-light on purpose (mirrors `providerVendors.js` / `cliProviderArgs.js`):
 * it imports nothing, so it stays importable from `providerModels.js`, which the
 * standalone autofixer process pulls in.
 *
 * **Three copies of this table exist, by architecture, and must stay in lockstep:**
 *   1. this file — the PortOS server;
 *   2. `aiToolkit/internal/gateways.js` — the vendored toolkit, which may not
 *      import out of its own directory (see `aiToolkit/CLAUDE.md`);
 *      `providerGateways.parity.test.js` fails when the two drift;
 *   3. `client/src/utils/providers.js` — the browser, which cannot import server
 *      code at all.
 */

/**
 * @typedef {object} ProviderGateway
 * @property {string} id — the OpenCode provider namespace, the `gatewayBacked`
 *   marker value, AND the id of the sibling `api` record holding the key. One
 *   string for all three on purpose: the sibling lookup is `providers[gateway.id]`.
 * @property {string} label — human name for UI copy and prerequisite labels.
 * @property {string} baseURL — the OpenAI-compatible endpoint.
 * @property {string} apiKeyEnv — the env var the spawner exports for OpenCode.
 * @property {string} [legacyMarker] — the pre-registry per-gateway boolean field
 *   (`orcarouterBacked`). Records written before `gatewayBacked` existed still
 *   carry it, and installs upgrade on their own schedule, so this is read
 *   FOREVER — no migration rewrites stored records.
 * @property {string} [legacyApiKeyField] — a pre-registry alias for the wrapper's
 *   own key field.
 */

/** @type {readonly ProviderGateway[]} */
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

/** Every gateway id — the namespace key space `opencodeConfig.js` extends. */
export const PROVIDER_GATEWAY_IDS = Object.freeze(PROVIDER_GATEWAYS.map((g) => g.id));

/** The registry row for a gateway id, or `null` for anything else. */
export const gatewayById = (id) => PROVIDER_GATEWAYS.find((g) => g.id === id) || null;

/** Is this OpenCode provider namespace a hosted gateway rather than a local runtime? */
export const isGatewayNamespace = (namespace) => PROVIDER_GATEWAY_IDS.includes(namespace);

/**
 * The gateway a provider record opts into, or `null`.
 *
 * Reads the generic `gatewayBacked: '<id>'` marker first, then each row's
 * `legacyMarker` boolean — so a record stored before this registry existed
 * resolves identically and needs no migration. Registry order breaks a tie on a
 * malformed record carrying two markers, preserving the legacy if-chain outcome.
 *
 * @param {{gatewayBacked?:string, [marker:string]:unknown}|null|undefined} provider
 * @returns {ProviderGateway|null}
 */
export function gatewayForProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const declared = gatewayById(provider.gatewayBacked);
  if (declared) return declared;
  return PROVIDER_GATEWAYS.find((g) => g.legacyMarker && provider[g.legacyMarker] === true) || null;
}

/** `gatewayForProvider`, reduced to the id (which is also the OpenCode namespace). */
export const gatewayIdForProvider = (provider) => gatewayForProvider(provider)?.id ?? null;
