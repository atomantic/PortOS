/**
 * Video reference-mode vocabulary and its per-mode rules.
 *
 * Re-export of `server/lib/videoReferenceModes.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/videoReferenceModes` import path in the client is unchanged.
 */
export {
  DEFAULT_I2V_REFERENCE_MODE,
  I2V_REFERENCE_MODES,
  I2V_REFERENCE_MODE_OPTIONS,
  I2V_REFERENCE_MODE_RUNTIMES,
  INSPIRE_DEFAULT_IMAGE_STRENGTH,
  i2vReferenceModeLabel,
  i2vReferenceModeViolation,
  isDefaultI2vReferenceMode,
  isKnownI2vReferenceMode,
  normalizeI2vReferenceMode,
  resolveI2vReferenceStrength,
  runtimeSupportsI2vReferenceMode,
} from '../../../server/lib/videoReferenceModes.js';
