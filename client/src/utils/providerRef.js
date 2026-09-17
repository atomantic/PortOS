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
export { parseProviderRef, PRESET_ID_RE, COMPOSITE_ID_RE } from '../../../server/lib/providerRef.js';
