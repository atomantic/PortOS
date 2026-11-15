/**
 * Parses provider id grammar: `parseProviderRef`, `isCompositeProviderId`, `isPresetProviderId`,
 * `formatCompositeId`, distinguishing preset ids from composite harness ids.
 *
 * `parseProviderRef(id)` / `isCompositeProviderId(id)` / `isPresetProviderId(id)` /
 * `formatCompositeId(parts)` / `PRESET_ID_RE` / `COMPOSITE_ID_RE` — the shared preset-vs-composite
 * grammar (#7566): distinguishes a preset id from a
 * `<harness>.<method>@<service-slug>[+<bootstrap-slug>]` composite so `useProviderCatalog`'s
 * `resolveRef` and `ProviderComposePopover` recognize the same strings the server does. Re-exported
 * from the pure leaf `server/lib/providerRef.js`, never copied.
 */

/**
 * Provider REFERENCE grammar (#7564, epic #7561), shared with the server.
 *
 * A `{ providerId, model, effort }` selection names its provider either by a
 * PRESET id (a `data/providers.json` slug) or by a COMPOSITE id —
 * `<harness>.<method>@<service-slug>[+<bootstrap-slug>]` — that
 * `useProviderCatalog`'s `resolveRef` synthesizes a display record for and
 * `ProviderComposePopover` emits when the user composes rather than picks a
 * preset. Re-exported from the pure server leaf (never copied) so the browser
 * recognizes exactly the same strings the server does — see
 * `server/lib/providerRef.js` for the full grammar rationale.
 */
export { parseProviderRef, isCompositeProviderId, isPresetProviderId, formatCompositeId, PRESET_ID_RE, COMPOSITE_ID_RE } from '../../../server/lib/providerRef.js';
