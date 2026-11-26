/**
 * Pipeline — voice-fingerprint matrix service (#2194, CWQE Phase 2 follow-up).
 *
 * Read-only orchestration over the pure primitives in
 * `server/lib/editorial/voiceFingerprint.js`: builds the `# Issue N` corpus the
 * `style.voice-drift` check reads (`collectManuscriptSections`/`sectionsCorpus`),
 * resolves the SAME per-series check config, and returns the full issues x metrics
 * matrix plus drift so the matrix view can highlight outlier cells. No LLM cost,
 * no mutation.
 */

import { getSeries } from './series.js';
import { collectManuscriptSections, sectionsCorpus } from './arcPlanner.js';
import { getSettings } from '../settings.js';
import { getCheckById, readChecksSlice, resolveCheckConfig } from '../../lib/editorial/checkRegistry.js';
import {
  computeVoiceDrift,
  parseVoiceWells,
  describeMetricColumn,
} from '../../lib/editorial/voiceFingerprint.js';

// The check whose per-series config governs both the finding run AND this view.
// Keep in sync with server/lib/editorial/checks/proseStyle.js.
export const VOICE_DRIFT_CHECK_ID = 'style.voice-drift';

/**
 * Resolve the effective `style.voice-drift` config for a series from the persisted
 * per-check settings, tolerant of a hand-edited or absent slice. `resolveCheckConfig`
 * validates through the check's Zod `configSchema`, so every key is populated
 * (`style.voice-drift` is statically registered, so `getCheckById` never misses).
 *
 * `seriesOverrides` (the series' `editorialCheckConfig`, #1591) is overlaid on the
 * global config as `applySeriesCheckConfig` does, so the matrix and the editor's
 * findings resolve the SAME config.
 *
 * @param {object} [settings] pre-loaded settings (optional; fetched when omitted)
 * @param {object} [seriesOverrides] the series' editorialCheckConfig map (optional)
 * @returns {Promise<{ sigmaThreshold: number, minIssues: number, vocabularyWells: string, maxFindings: number, baselineMode: string }>}
 */
export async function resolveVoiceDriftConfig(settings, seriesOverrides) {
  const s = settings || await getSettings();
  const check = getCheckById(s, VOICE_DRIFT_CHECK_ID);
  const stored = readChecksSlice(s)[VOICE_DRIFT_CHECK_ID]?.config;
  const global = resolveCheckConfig(check, stored);
  const override = seriesOverrides && typeof seriesOverrides === 'object' && !Array.isArray(seriesOverrides)
    ? seriesOverrides[VOICE_DRIFT_CHECK_ID]
    : null;
  if (!override || typeof override !== 'object' || Array.isArray(override)) return global;
  // Overlay on the RESOLVED global exactly as applySeriesCheckConfig does, including
  // its failure mode: an invalid merged blob keeps the resolved global (not bare
  // schema defaults) so the matrix and the finding run stay in lockstep.
  const parsed = check.configSchema.safeParse({ ...global, ...override });
  return parsed.success ? parsed.data : global;
}

/**
 * Compute the full voice-fingerprint matrix + drift for a series' drafted
 * manuscript. Throws the service error the route maps to a 404 for a missing series.
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
 *   seriesFindings: object[],
 * }>}
 */
export async function getVoiceFingerprint(seriesId) {
  // Throws when missing (route maps to 404), before any manuscript I/O. The record is
  // kept: the drift baseline can be the style guide's chosen-voice exemplars (#2179).
  const series = await getSeries(seriesId);

  const [sections, cfg] = await Promise.all([
    collectManuscriptSections(seriesId),
    resolveVoiceDriftConfig(undefined, series?.editorialCheckConfig),
  ]);

  // `cfg` is schema-validated (defaults applied), so no `??` is needed; it matches the
  // finding-emitting run, chosen-voice baseline included.
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
    // #2248: series-wide "uniformly off the chosen voice" findings, shown as a banner.
    seriesFindings: drift.seriesFindings || [],
  };
}
