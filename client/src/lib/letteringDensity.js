/**
 * Comic lettering-density accounting, so the comic-script stage’s inline per-page warnings match the authoritative editorial check.
 *
 * Re-export of `server/lib/editorial/letteringDensity.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/letteringDensity` import path in the client is unchanged.
 */
export {
  DEFAULT_LETTERING_THRESHOLDS,
  LETTERING_SEVERITIES,
  analyzeComicLettering,
  overflowSeverity,
  panelLetteringMetrics,
  sanitizeLetteringThresholds,
} from '../../../server/lib/editorial/letteringDensity.js';
