/**
 * Pipeline — voice-fingerprint matrix service (#2194, CWQE Phase 2 follow-up).
 *
 * A thin read-only orchestration over the pure primitives in
 * `server/lib/editorial/voiceFingerprint.js`: it stitches the series' drafted
 * manuscript into the `# Issue N` corpus (the exact same corpus the deterministic
 * `style.voice-drift` check reads — via `collectManuscriptSections`/`sectionsCorpus`),
 * resolves the SAME per-series check config (drift threshold, minIssues, and the
 * optional vocabulary-wells spec), then returns the full issues×metrics matrix plus
 * the drift result so the dedicated matrix view can render every issue's fingerprint
 * vector with the flagged outlier cells highlighted — not just the flagged outliers
 * that surface as editorial findings.
 *
 * Pure math lives in the lib primitive; this file only reads state (series existence,
 * manuscript sections, resolved check config). No LLM cost, no mutation.
 */

import { getSeries } from './series.js';
import { collectManuscriptSections, sectionsCorpus } from './arcPlanner.js';
import { getSettings } from '../settings.js';
import {
  getCheckById,
  readChecksSlice,
  resolveCheckConfig,
} from '../../lib/editorial/index.js';
import {
  computeVoiceDrift,
  parseVoiceWells,
  describeMetricColumn,
} from '../../lib/editorial/voiceFingerprint.js';

// The deterministic check whose per-series config (threshold / minIssues /
// vocabulary wells) governs both the finding-emitting run AND this read view, so
// the matrix agrees with what the editor flags. Keep in sync with the check id in
// server/lib/editorial/checks/proseStyle.js.
export const VOICE_DRIFT_CHECK_ID = 'style.voice-drift';

/**
 * Resolve the effective `style.voice-drift` config for a series from the persisted
 * per-check settings (threshold / minIssues / vocabularyWells / baselineMode),
 * tolerant of a hand-edited or absent slice. `resolveCheckConfig` validates the
 * stored slice through the check's Zod `configSchema`, so every key comes back
 * populated with its schema default when unset — the caller can trust the fields
 * are present. (`style.voice-drift` is statically registered, so `getCheckById`
 * never misses.)
 *
 * `seriesOverrides` is the series' `editorialCheckConfig` map (#1591): when it
 * carries an override for this check, it is overlaid on the global stored config
 * exactly as `applySeriesCheckConfig` does for the finding-emitting run — so the
 * matrix view and the editor's findings resolve the SAME effective config (a
 * per-series `baselineMode`/threshold override drives both).
 *
 * @param {object} [settings] pre-loaded settings (optional; fetched when omitted)
 * @param {object} [seriesOverrides] the series' editorialCheckConfig map (optional)
 * @returns {Promise<{ sigmaThreshold: number, minIssues: number, vocabularyWells: string, maxFindings: number, baselineMode: string }>}
 */
export async function resolveVoiceDriftConfig(settings, seriesOverrides) {
  const s = settings || await getSettings();
  const check = getCheckById(s, VOICE_DRIFT_CHECK_ID);
  const stored = readChecksSlice(s)[VOICE_DRIFT_CHECK_ID]?.config;
  const override = seriesOverrides && typeof seriesOverrides === 'object' && !Array.isArray(seriesOverrides)
    ? seriesOverrides[VOICE_DRIFT_CHECK_ID]
    : null;
  // Overlay the per-series override on the global stored config before validating,
  // mirroring applySeriesCheckConfig's `{ ...config, ...override }` merge. A
  // non-object override is ignored (the spread of a non-object is a no-op).
  const merged = (override && typeof override === 'object' && !Array.isArray(override))
    ? { ...(stored || {}), ...override }
    : stored;
  return resolveCheckConfig(check, merged);
}

/**
 * Compute the full voice-fingerprint matrix + drift for a series' drafted
 * manuscript. Verifies the series exists (throws the service error the route maps
 * to a 404), stitches the manuscript corpus, resolves the check config, and returns
 * a UI-ready structured payload.
 *
 * @param {string} seriesId
 * @returns {Promise<{
 *   seriesId: string,
 *   config: object,
 *   wells: string[],
 *   columns: Array<{ key, label, unit, higher, lower, isWell }>,
 *   gatedOff: boolean,
 *   issueCount: number,
 *   threshold: number,
 *   baselineMode: string,
 *   exemplarBaselineUsed: boolean,
 *   matrix: object,
 *   series: object,
 *   outliers: object[],
 * }>}
 */
export async function getVoiceFingerprint(seriesId) {
  // Throws when the series is missing — the route maps it to a 404. Runs before any
  // manuscript I/O so a bad id fails fast. Keep the loaded record: the drift baseline
  // can be the style guide's chosen-voice exemplars (#2179).
  const series = await getSeries(seriesId);

  const [sections, cfg] = await Promise.all([
    collectManuscriptSections(seriesId),
    // Overlay this series' per-check overrides (#1591) so the matrix view resolves
    // the same effective config the finding-emitting run does.
    resolveVoiceDriftConfig(undefined, series?.editorialCheckConfig),
  ]);

  // `cfg` is schema-validated, so sigmaThreshold/minIssues/vocabularyWells/baselineMode
  // are always present (defaults applied by resolveCheckConfig) — no `??` needed. The
  // matrix view resolves the SAME config the finding-emitting run does, including the
  // chosen-voice baseline, so the highlighted outliers agree with the editor's findings.
  const drift = computeVoiceDrift(sectionsCorpus(sections), {
    threshold: cfg.sigmaThreshold,
    minIssues: cfg.minIssues,
    wells: parseVoiceWells(cfg.vocabularyWells),
    baselineMode: cfg.baselineMode,
    voiceExemplars: series?.styleGuide?.voiceExemplars,
  });

  return {
    seriesId,
    config: cfg,
    wells: drift.matrix.wells || [],
    columns: (drift.matrix.metricKeys || []).map(describeMetricColumn),
    gatedOff: drift.gatedOff,
    issueCount: drift.issueCount,
    threshold: drift.threshold,
    baselineMode: drift.baselineMode,
    exemplarBaselineUsed: drift.exemplarBaselineUsed,
    matrix: drift.matrix,
    series: drift.series,
    outliers: drift.outliers,
  };
}
