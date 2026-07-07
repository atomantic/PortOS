import { describe, it, expect, vi, beforeEach } from 'vitest';

// A stitched manuscript with 5 issues; issue 5 is deliberately metronomic (every
// sentence the same short length) so it drifts on the sentence-rhythm metrics.
const VARIED = 'The knight rode north through the burning fields. '
  + 'He remembered, suddenly and against his will, the long slow summers of a childhood that no longer belonged to anyone alive, '
  + 'and the memory tasted of ash. Rain. It fell like a curtain across the ruined valley, and the horse balked. '
  + '"We should turn back," she said. He shook his head, saying nothing, watching the smoke climb.';
const METRONOMIC = 'The man walked home. The dog ran fast. The sun went down. '
  + 'The rain came hard. The road was long. The night grew cold. The fire burned low. The end came soon.';

function buildManuscript() {
  const sections = [];
  for (let n = 1; n <= 4; n += 1) sections.push(`# Issue ${n} — Chapter ${n} (prose)\n\n${VARIED}`);
  sections.push(`# Issue 5 — Chapter 5 (prose)\n\n${METRONOMIC}`);
  return sections.join('\n\n---\n\n');
}

let settingsStore = {};
let manuscriptCorpus = buildManuscript();

let seriesStyleGuide = null;
let seriesEditorialCheckConfig = null;
vi.mock('./series.js', () => ({
  getSeries: vi.fn(async (id) => {
    if (id === 'missing') throw Object.assign(new Error('nope'), { code: 'PIPELINE_SERIES_NOT_FOUND' });
    return { id, name: 'Test Series', styleGuide: seriesStyleGuide, editorialCheckConfig: seriesEditorialCheckConfig };
  }),
}));

vi.mock('./arcPlanner.js', () => ({
  collectManuscriptSections: vi.fn(async () => [{ number: 1, content: 'x' }]),
  sectionsCorpus: vi.fn(() => manuscriptCorpus),
}));

vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => settingsStore),
}));

const { getVoiceFingerprint, resolveVoiceDriftConfig, VOICE_DRIFT_CHECK_ID } = await import('./voiceFingerprint.js');

beforeEach(() => {
  settingsStore = {};
  manuscriptCorpus = buildManuscript();
  seriesStyleGuide = null;
  seriesEditorialCheckConfig = null;
});

describe('resolveVoiceDriftConfig', () => {
  it('falls back to registry defaults when nothing is stored', async () => {
    const cfg = await resolveVoiceDriftConfig();
    expect(cfg.sigmaThreshold).toBe(1.5);
    expect(cfg.minIssues).toBe(4);
    expect(cfg.vocabularyWells).toBe('');
    expect(cfg.baselineMode).toBe('drafted');
  });

  it('reads the persisted per-check config slice', async () => {
    settingsStore = {
      pipelineEditorialChecks: {
        checks: {
          [VOICE_DRIFT_CHECK_ID]: { config: { sigmaThreshold: 2, minIssues: 3, vocabularyWells: 'trade: forge, anvil' } },
        },
      },
    };
    const cfg = await resolveVoiceDriftConfig();
    expect(cfg.sigmaThreshold).toBe(2);
    expect(cfg.minIssues).toBe(3);
    expect(cfg.vocabularyWells).toBe('trade: forge, anvil');
  });

  it('overlays a per-series editorialCheckConfig override on the global config (#1591)', async () => {
    settingsStore = {
      pipelineEditorialChecks: {
        checks: { [VOICE_DRIFT_CHECK_ID]: { config: { sigmaThreshold: 2, baselineMode: 'drafted' } } },
      },
    };
    // The series override flips baselineMode and threshold; the un-overridden
    // global sigmaThreshold is replaced, other globals persist.
    const cfg = await resolveVoiceDriftConfig(undefined, {
      [VOICE_DRIFT_CHECK_ID]: { baselineMode: 'blended', sigmaThreshold: 1.2 },
    });
    expect(cfg.baselineMode).toBe('blended');
    expect(cfg.sigmaThreshold).toBe(1.2);
  });

  it('ignores a non-object per-series override', async () => {
    const cfg = await resolveVoiceDriftConfig(undefined, { [VOICE_DRIFT_CHECK_ID]: 'nope' });
    expect(cfg.baselineMode).toBe('drafted');
  });
});

describe('getVoiceFingerprint', () => {
  it('returns a UI-ready matrix + drift for a drafted series', async () => {
    const res = await getVoiceFingerprint('ser-1');
    expect(res.seriesId).toBe('ser-1');
    expect(res.gatedOff).toBe(false);
    expect(res.issueCount).toBe(5);
    expect(res.threshold).toBe(1.5);
    // A stable, self-describing column list (static metrics; no wells configured).
    expect(res.columns.length).toBeGreaterThan(0);
    expect(res.columns.every((c) => typeof c.label === 'string' && typeof c.key === 'string')).toBe(true);
    expect(res.wells).toEqual([]);
    // Every issue is a matrix row with a numeric metric per column.
    expect(res.matrix.issues.map((it) => it.issue)).toEqual([1, 2, 3, 4, 5]);
    for (const it of res.matrix.issues) {
      for (const col of res.columns) {
        expect(typeof it.metrics[col.key]).toBe('number');
      }
    }
    // The metronomic issue 5 drifts — at least one outlier is flagged, all with
    // the fields the UI highlights on.
    expect(res.outliers.length).toBeGreaterThan(0);
    expect(res.outliers.some((o) => o.issue === 5)).toBe(true);
    for (const o of res.outliers) {
      expect(o).toHaveProperty('metricKey');
      expect(o).toHaveProperty('z');
      expect(['high', 'low']).toContain(o.direction);
    }
    // Series mean/σ footer keyed per metric.
    for (const col of res.columns) {
      expect(res.series[col.key]).toHaveProperty('mean');
      expect(res.series[col.key]).toHaveProperty('std');
    }
  });

  it('gates off below minIssues (matrix still returned for reference)', async () => {
    manuscriptCorpus = ['# Issue 1 (prose)\n\nThe man walked home.', '# Issue 2 (prose)\n\nThe dog ran fast.']
      .join('\n\n---\n\n');
    const res = await getVoiceFingerprint('ser-1');
    expect(res.gatedOff).toBe(true);
    expect(res.issueCount).toBe(2);
    expect(res.outliers).toEqual([]);
    expect(res.matrix.issues.length).toBe(2);
  });

  it('appends configured vocabulary wells as columns', async () => {
    settingsStore = {
      pipelineEditorialChecks: {
        checks: {
          [VOICE_DRIFT_CHECK_ID]: { config: { vocabularyWells: 'trade: forge, anvil, knight' } },
        },
      },
    };
    const res = await getVoiceFingerprint('ser-1');
    expect(res.wells).toContain('trade');
    const wellCol = res.columns.find((c) => c.key === 'well:trade');
    expect(wellCol).toBeTruthy();
    expect(wellCol.isWell).toBe(true);
  });

  it('propagates a NOT_FOUND error for a missing series', async () => {
    await expect(getVoiceFingerprint('missing')).rejects.toMatchObject({ code: 'PIPELINE_SERIES_NOT_FOUND' });
  });

  it('drafted baseline is the default and reports it (#2179)', async () => {
    const res = await getVoiceFingerprint('ser-1');
    expect(res.baselineMode).toBe('drafted');
    expect(res.exemplarBaselineUsed).toBe(false);
  });

  it('measures against the style guide chosen voice when configured (#2179)', async () => {
    settingsStore = {
      pipelineEditorialChecks: {
        checks: { [VOICE_DRIFT_CHECK_ID]: { config: { baselineMode: 'exemplars' } } },
      },
    };
    // A metronomic chosen voice — so the VARIED issues drift against it.
    seriesStyleGuide = { voiceExemplars: [{ passage: METRONOMIC }, { passage: METRONOMIC }] };
    const res = await getVoiceFingerprint('ser-1');
    expect(res.baselineMode).toBe('exemplars');
    expect(res.exemplarBaselineUsed).toBe(true);
    // The center row differs from the drafted mean on at least one metric.
    const shifted = res.columns.some((c) => {
      const s = res.series[c.key];
      return s && Number.isFinite(s.center) && Math.abs(s.center - s.mean) > 1e-6;
    });
    expect(shifted).toBe(true);
  });

  it('applies a per-series editorialCheckConfig override for the baseline (#2179/#1591)', async () => {
    // Global config leaves baselineMode at the default 'drafted'; the SERIES
    // override flips it to exemplars — the matrix must honor the override, exactly
    // as the finding-emitting run does via applySeriesCheckConfig.
    seriesStyleGuide = { voiceExemplars: [{ passage: METRONOMIC }, { passage: METRONOMIC }] };
    seriesEditorialCheckConfig = { [VOICE_DRIFT_CHECK_ID]: { baselineMode: 'exemplars' } };
    const res = await getVoiceFingerprint('ser-1');
    expect(res.baselineMode).toBe('exemplars');
    expect(res.exemplarBaselineUsed).toBe(true);
  });

  it('falls back to drafted when configured for exemplars but the style guide has none (#2179)', async () => {
    settingsStore = {
      pipelineEditorialChecks: {
        checks: { [VOICE_DRIFT_CHECK_ID]: { config: { baselineMode: 'exemplars' } } },
      },
    };
    seriesStyleGuide = { voiceExemplars: [] };
    const res = await getVoiceFingerprint('ser-1');
    expect(res.baselineMode).toBe('drafted');
    expect(res.exemplarBaselineUsed).toBe(false);
  });
});
