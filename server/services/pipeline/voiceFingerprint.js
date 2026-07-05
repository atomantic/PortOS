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
  metricLabel,
  VOICE_METRICS,
} from '../../lib/editorial/voiceFingerprint.js';

// The deterministic check whose per-series config (threshold / minIssues /
// vocabulary wells) governs both the finding-emitting run AND this read view, so
// the matrix agrees with what the editor flags. Keep in sync with the check id in
// server/lib/editorial/checks/proseStyle.js.
export const VOICE_DRIFT_CHECK_ID = 'style.voice-drift';

// One column descriptor per metric key so the UI renders a stable, self-describing
// header without re-deriving labels/units/direction phrasing client-side. `higher`
// / `lower` explain what a value above/below the series mean MEANS for that metric;
// wells share a generic phrasing (no static descriptor).
function describeColumn(key) {
  const desc = VOICE_METRICS.find((m) => m.key === key);
  if (desc) {
    return {
      key,
      label: desc.label,
      unit: desc.unit || '',
      higher: desc.higher,
      lower: desc.lower,
      isWell: false,
    };
  }
  const isWell = typeof key === 'string' && key.startsWith('well:');
  return {
    key,
    label: metricLabel(key),
    unit: '',
    higher: isWell ? `leans harder on the "${key.slice(5)}" register` : 'runs high',
    lower: isWell ? `uses the "${key.slice(5)}" register less` : 'runs low',
    isWell,
  };
}

/**
 * Resolve the effective `style.voice-drift` config for a series from the persisted
 * per-check settings (threshold / minIssues / vocabularyWells), tolerant of a
 * hand-edited or absent slice — falls back to the registry defaults via
 * `resolveCheckConfig`.
 *
 * @param {object} [settings] pre-loaded settings (optional; fetched when omitted)
 * @returns {Promise<{ sigmaThreshold: number, minIssues: number, vocabularyWells: string }>}
 */
export async function resolveVoiceDriftConfig(settings) {
  const s = settings || await getSettings();
  const check = getCheckById(s, VOICE_DRIFT_CHECK_ID);
  if (!check) return { sigmaThreshold: 1.5, minIssues: 4, vocabularyWells: '' };
  const stored = readChecksSlice(s)[VOICE_DRIFT_CHECK_ID] || {};
  return resolveCheckConfig(check, stored.config);
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
 *   config: { sigmaThreshold: number, minIssues: number, vocabularyWells: string },
 *   wells: string[],
 *   columns: Array<{ key, label, unit, higher, lower, isWell }>,
 *   gatedOff: boolean,
 *   issueCount: number,
 *   threshold: number,
 *   matrix: object,
 *   series: object,
 *   outliers: object[],
 * }>}
 */
export async function getVoiceFingerprint(seriesId) {
  // Throws when the series is missing — the route maps it to a 404. Runs before any
  // manuscript I/O so a bad id fails fast.
  await getSeries(seriesId);

  const [sections, cfg] = await Promise.all([
    collectManuscriptSections(seriesId),
    resolveVoiceDriftConfig(),
  ]);
  const manuscript = sectionsCorpus(sections);
  const wells = parseVoiceWells(cfg.vocabularyWells || '');

  const drift = computeVoiceDrift(manuscript, {
    threshold: cfg.sigmaThreshold ?? 1.5,
    minIssues: cfg.minIssues ?? 4,
    wells,
  });

  const columns = (drift.matrix.metricKeys || []).map(describeColumn);

  return {
    seriesId,
    config: {
      sigmaThreshold: cfg.sigmaThreshold ?? 1.5,
      minIssues: cfg.minIssues ?? 4,
      vocabularyWells: cfg.vocabularyWells || '',
    },
    wells: drift.matrix.wells || [],
    columns,
    gatedOff: drift.gatedOff,
    issueCount: drift.issueCount,
    threshold: drift.threshold,
    matrix: drift.matrix,
    series: drift.series,
    outliers: drift.outliers,
  };
}
