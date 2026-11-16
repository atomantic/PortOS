/**
 * Re-export of `server/lib/assetProvenance.js`.
 *
 * Stamp-time model/LoRA license provenance + rollup for collection/export Attribution.
 */

/**
 * Provenance vocabulary + readers for a generated asset.
 *
 * Re-export of `server/lib/assetProvenance.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/assetProvenance` import path in the client is unchanged.
 */
export { licenseLabel, resolveAssetProvenance, rollupProvenance } from '../../../server/lib/assetProvenance.js';
