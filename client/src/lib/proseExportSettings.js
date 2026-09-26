/**
 * Prose export settings — re-export of server/lib/proseExportSettings.js.
 *
 * The client and server share the trim-size and font enums so they cannot drift.
 * The file stays so every `client/src/lib/proseExportSettings` import path is unchanged.
 */
export {
  TRIM_SIZES,
  DEFAULT_TRIM_SIZE,
  INTERIOR_FONTS,
  DEFAULT_INTERIOR_FONT,
} from '../../../server/lib/proseExportSettings.js';
