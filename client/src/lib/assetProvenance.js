/**
 * Provenance vocabulary + readers for a generated asset.
 *
 * Re-export of `server/lib/assetProvenance.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/assetProvenance` import path in the client is unchanged.
 */
export {
  PROVENANCE_SCHEMA_VERSION,
  PROVENANCE_SOURCE_KINDS,
  UNKNOWN_LICENSE_LABEL,
  buildProvenance,
  buildProvenanceSource,
  formatProvenanceSource,
  huggingfaceUrl,
  licenseFromCivitaiModel,
  licenseFromHuggingFaceModel,
  licenseFromRegistryModel,
  licenseLabel,
  normalizeLicense,
  provenanceForRender,
  readProvenance,
  resolveAssetProvenance,
  rollupProvenance,
} from '../../../server/lib/assetProvenance.js';
