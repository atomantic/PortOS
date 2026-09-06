/**
 * Tribe check-in cadence vocabulary.
 *
 * Re-export of `server/lib/tribeCadence.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/tribeCadence` import path in the client is unchanged.
 */
export {
  DEFAULT_CADENCE_DAYS,
  SOON_WINDOW_DAYS,
  cadenceStatus,
  daysSinceDate,
} from '../../../server/lib/tribeCadence.js';
