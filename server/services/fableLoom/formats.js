/**
 * Re-export shim. The format vocabulary and its prompt contracts moved to
 * `server/lib/fableLoomFormats.js` so `lib/fableLoomValidation.js` can read them
 * without importing upward into services (issue #4901). They were always a leaf
 * module; only the address changed. Existing deep imports keep working.
 */

export {
  LOOM_FORMATS,
  LOOM_FORMAT_DEFAULT,
  isLoomFormat,
  asLoomFormat,
  sceneFormatContract,
  narrationFormatContract,
  loomFormatLabel,
} from '../../lib/fableLoomFormats.js';
