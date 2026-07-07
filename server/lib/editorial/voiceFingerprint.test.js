import { describe, it, expect } from 'vitest';
import {
  VOICE_METRICS,
  VOICE_BASELINE_MODES,
  parseVoiceWells,
  computeFingerprint,
  computeExemplarBaseline,
  splitManuscriptByIssue,
  voiceFingerprintMatrix,
  computeVoiceDrift,
  describeDrift,
  describeSeriesDrift,
  renderFingerprintTable,
  metricLabel,
} from './voiceFingerprint.js';
import { getCheck } from './checkRegistry.js';

// A sentence of exactly `w` distinct words ending in a period. Words are numeric
// tokens so they carry no abstract suffix / simile marker and every sentence
// opens with the same word ("w0…") — keeping the non-tested metrics flat (σ 0)
// so a fixture's drift is isolated to sentence/paragraph length.
const sentence = (w) => `${Array.from({ length: w }, (_, i) => `w${i}`).join(' ')}.`;
// One issue block = `n` sentences of `w` words, on a single line (one paragraph).
const issueBlock = (n, w) => Array.from({ length: n }, () => sentence(w)).join(' ');
// Stitch per-issue blocks under `# Issue N` headers the way the manuscript
// stitcher does.
const manuscriptOf = (blocks) =>
  blocks.map((b, i) => `# Issue ${i + 1}\n\n${b}`).join('\n\n');

describe('parseVoiceWells', () => {
  it('parses categories, words, and lowercases + dedupes', () => {
    const wells = parseVoiceWells('Trade: Forge, Anvil, temper ; body: pulse, sinew');
    expect(wells).toEqual([
      { name: 'trade', words: new Set(['forge', 'anvil', 'temper']) },
      { name: 'body', words: new Set(['pulse', 'sinew']) },
    ]);
  });

  it('skips malformed / empty fragments and duplicate names, never throws', () => {
    expect(parseVoiceWells('')).toEqual([]);
    expect(parseVoiceWells('   ')).toEqual([]);
    expect(parseVoiceWells('no-colon-here')).toEqual([]);
    expect(parseVoiceWells('empty: ; body: pulse')).toEqual([
      { name: 'body', words: new Set(['pulse']) },
    ]);
    // First "trade" wins; the duplicate is dropped.
    const dup = parseVoiceWells('trade: forge; trade: anvil');
    expect(dup).toHaveLength(1);
    expect(dup[0].words).toEqual(new Set(['forge']));
  });
});

describe('computeFingerprint', () => {
  it('measures sentence-length mean/std/CV and fragment/long rates', () => {
    // Three sentences: 3, 3, and 30 words → mean 12, and the 30-word one is NOT
    // > 30 (long is strictly > 30) while the 3-word ones ARE < 5 (fragments).
    const text = `${sentence(3)} ${sentence(3)} ${sentence(30)}`;
    const fp = computeFingerprint(text);
    expect(fp.sentences).toBe(3);
    expect(fp.metrics.sentenceLenMean).toBe(12); // (3+3+30)/3
    // fragments = the two 3-word sentences → 2/3 = 66.7%
    expect(fp.metrics.fragmentPct).toBe(66.7);
    // long (>30) — the 30-word sentence is exactly 30, not > 30 → 0%
    expect(fp.metrics.longSentencePct).toBe(0);
  });

  it('flags a > 30 word sentence as long', () => {
    const fp = computeFingerprint(`${sentence(10)} ${sentence(31)}`);
    expect(fp.metrics.longSentencePct).toBe(50); // 1 of 2
  });

  it('measures dialogue ratio from quoted spans', () => {
    // 4 words total, 2 inside quotes → 50%.
    const fp = computeFingerprint('She said "run now" quietly.');
    // words: She said run now quietly = 5; quoted "run now" = 2 → 40%
    expect(fp.metrics.dialogueRatio).toBe(40);
  });

  it('measures em-dash rate, abstract-noun density, and simile density per 1k', () => {
    // "realization" (tion) + "kindness" (ness) are abstract; 2 of 9 words → 222.2/1k.
    const abstract = computeFingerprint('the realization brought a strange kindness to him now');
    expect(abstract.metrics.abstractNounDensity).toBe(222.2);

    const dash = computeFingerprint('a b c — d e f g h i');
    // 1 em-dash, 9 word tokens (dash isn't a word) → 111.1/1k
    expect(dash.metrics.emDashRate).toBe(111.1);

    // "like a" and "as bright as" → 2 similes over 9 words → 222.2/1k.
    const simile = computeFingerprint('it moved like a ghost as bright as dawn');
    expect(simile.metrics.simileDensity).toBe(222.2);
  });

  it('measures dominant sentence-opener share', () => {
    // Two of three sentences open with "he" → 66.7%.
    const fp = computeFingerprint('He ran. He fell. She laughed.');
    expect(fp.metrics.dominantOpenerPct).toBe(66.7);
  });

  it('tracks configured vocabulary wells as per-1k coverage', () => {
    const wells = parseVoiceWells('trade: forge, anvil');
    // "forge" appears once in 4 words → 250/1k.
    const fp = computeFingerprint('the forge burned bright', { wells });
    expect(fp.metrics['well:trade']).toBe(250);
  });

  it('returns all-zero (never NaN) metrics for empty text', () => {
    const fp = computeFingerprint('');
    expect(fp.words).toBe(0);
    for (const key of VOICE_METRICS.map((m) => m.key)) {
      expect(Number.isFinite(fp.metrics[key])).toBe(true);
      expect(fp.metrics[key]).toBe(0);
    }
  });
});

describe('splitManuscriptByIssue', () => {
  it('splits on # Issue N headers in numeric order', () => {
    const ms = '# Issue 2\n\nbeta prose here.\n\n# Issue 1\n\nalpha prose here.';
    const blocks = splitManuscriptByIssue(ms);
    expect(blocks.map((b) => b.issue)).toEqual([1, 2]);
    expect(blocks.find((b) => b.issue === 1).text).toContain('alpha');
    expect(blocks.find((b) => b.issue === 2).text).toContain('beta');
  });

  it('merges duplicate issue headers (a chunk boundary) into one block', () => {
    const ms = '# Issue 1\n\nfirst half.\n\n# Issue 1\n\nsecond half.';
    const blocks = splitManuscriptByIssue(ms);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('first half');
    expect(blocks[0].text).toContain('second half');
  });

  it('returns [] with no headers or empty input', () => {
    expect(splitManuscriptByIssue('just prose, no headers')).toEqual([]);
    expect(splitManuscriptByIssue('')).toEqual([]);
    expect(splitManuscriptByIssue(null)).toEqual([]);
  });
});

describe('voiceFingerprintMatrix', () => {
  it('fingerprints every issue and lists metric keys with wells last', () => {
    const wells = parseVoiceWells('trade: forge');
    const ms = manuscriptOf([issueBlock(2, 5), issueBlock(2, 5)]);
    const matrix = voiceFingerprintMatrix(ms, { wells });
    expect(matrix.issues.map((i) => i.issue)).toEqual([1, 2]);
    expect(matrix.metricKeys[0]).toBe('sentenceLenMean');
    expect(matrix.metricKeys[matrix.metricKeys.length - 1]).toBe('well:trade');
    expect(matrix.wells).toEqual(['trade']);
  });
});

describe('computeVoiceDrift', () => {
  it('gates off below minIssues (σ meaningless)', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 20)]); // only 2 issues
    const drift = computeVoiceDrift(ms);
    expect(drift.gatedOff).toBe(true);
    expect(drift.issueCount).toBe(2);
    expect(drift.outliers).toEqual([]);
  });

  it('excludes empty / not-yet-drafted issue sections from the gate and stats', () => {
    // Three drafted issues + one empty stub header → only 3 contentful issues,
    // below the default minIssues of 4, so the check gates off rather than
    // treating the stub as a fourth issue.
    const withStub = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5)]) + '\n\n# Issue 4\n\n   ';
    const gated = computeVoiceDrift(withStub);
    expect(gated.gatedOff).toBe(true);
    expect(gated.issueCount).toBe(3);

    // Four drafted issues + an empty stub → the stub is neither counted toward
    // the gate nor flagged as a (wild all-zero) outlier.
    const withStub2 = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5)]) + '\n\n# Issue 5\n\n';
    const drift = computeVoiceDrift(withStub2);
    expect(drift.gatedOff).toBe(false);
    expect(drift.issueCount).toBe(4);
    expect(drift.outliers.some((o) => o.issue === 5)).toBe(false);
  });

  it('defaults minIssues to 4 — a 3-issue series gates off (√2 < 1.5σ ceiling)', () => {
    // Three drafted issues, one drifting. At N=3 the largest possible z is √2 ≈
    // 1.41, below the default 1.5σ threshold, so the default gate stays closed.
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 20)]);
    expect(computeVoiceDrift(ms).gatedOff).toBe(true);
    // An explicit minIssues:3 with a low enough threshold can still flag (√2 clears 1.0).
    const opened = computeVoiceDrift(ms, { minIssues: 3, threshold: 1.0 });
    expect(opened.gatedOff).toBe(false);
    expect(opened.outliers.some((o) => o.metricKey === 'sentenceLenMean')).toBe(true);
  });

  it('flags the outlier issue on sentence-length mean with hand-computed σ', () => {
    // 3 issues at mean 5, 1 issue at mean 20 → values [5,5,5,20].
    // mean = 8.75, σ = √42.1875 ≈ 6.495, z(issue4) = 11.25/6.495 ≈ 1.732 (> 1.5).
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 20)]);
    const drift = computeVoiceDrift(ms);
    expect(drift.gatedOff).toBe(false);
    expect(drift.series.sentenceLenMean.mean).toBeCloseTo(8.75, 2);
    // Every outlier is the drifting issue (4), never issues 1–3.
    expect(drift.outliers.every((o) => o.issue === 4)).toBe(true);
    const meanOutlier = drift.outliers.find((o) => o.metricKey === 'sentenceLenMean');
    expect(meanOutlier).toBeTruthy();
    expect(meanOutlier.direction).toBe('high');
    expect(Math.abs(meanOutlier.z)).toBeCloseTo(1.732, 2);
  });

  it('skips metrics with zero spread (no manufactured infinite z)', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 20)]);
    const drift = computeVoiceDrift(ms);
    // No issue uses similes / em-dashes / fragments → those σ are 0, so they can
    // never produce an outlier.
    for (const flat of ['simileDensity', 'emDashRate', 'sentenceLenStd', 'sentenceLenCV']) {
      expect(drift.outliers.some((o) => o.metricKey === flat)).toBe(false);
      expect(drift.series[flat].std).toBe(0);
    }
  });

  it('respects a custom sigma threshold', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 20)]);
    // z ≈ 1.732: flagged at 1.5, but NOT at 2.0.
    expect(computeVoiceDrift(ms, { threshold: 2.0 }).outliers.some((o) => o.metricKey === 'sentenceLenMean')).toBe(false);
    expect(computeVoiceDrift(ms, { threshold: 1.5 }).outliers.some((o) => o.metricKey === 'sentenceLenMean')).toBe(true);
  });

  it('sorts outliers by |z| descending', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 40)]);
    const drift = computeVoiceDrift(ms);
    const zs = drift.outliers.map((o) => Math.abs(o.z));
    for (let i = 1; i < zs.length; i += 1) expect(zs[i - 1]).toBeGreaterThanOrEqual(zs[i]);
  });
});

describe('computeExemplarBaseline (#2179)', () => {
  it('combines exemplar passages into one fingerprint', () => {
    // Two passages, each 4 sentences of 8 words → combined mean 8 words/sentence.
    const exemplars = [
      { passage: issueBlock(4, 8), note: 'spare, clipped' },
      { passage: issueBlock(4, 8) },
    ];
    const baseline = computeExemplarBaseline(exemplars);
    expect(baseline).toBeTruthy();
    expect(baseline.passages).toBe(2);
    expect(baseline.metrics.sentenceLenMean).toBe(8);
    expect(baseline.words).toBeGreaterThanOrEqual(40);
  });

  it('returns null for no usable passages', () => {
    expect(computeExemplarBaseline(null)).toBeNull();
    expect(computeExemplarBaseline([])).toBeNull();
    expect(computeExemplarBaseline([{ note: 'no passage' }, { passage: '   ' }])).toBeNull();
  });

  it('returns null when the combined text is below the min-word floor', () => {
    // A single short passage (< 40 words) is too thin to center against.
    expect(computeExemplarBaseline([{ passage: issueBlock(1, 5) }])).toBeNull();
  });

  it('honors configured wells', () => {
    const wells = parseVoiceWells('trade: forge');
    const baseline = computeExemplarBaseline(
      [{ passage: 'the forge burned bright and hot today '.repeat(8) }], // 56 words, ≥ floor
      { wells },
    );
    expect(baseline).toBeTruthy();
    expect(baseline.metrics['well:trade']).toBeGreaterThan(0);
  });
});

describe('computeVoiceDrift baseline modes (#2179)', () => {
  // Four drafted issues that all share a sentence-length mean of 20 words — so the
  // drafted mean is 20 and the drafted σ on that metric is 0 (no drafted-mode
  // drift possible). The style-guide exemplars establish a much SHORTER chosen
  // voice (mean 5), so every drafted issue is far from the chosen voice.
  const draftedUniform = manuscriptOf([issueBlock(4, 20), issueBlock(4, 20), issueBlock(4, 20), issueBlock(4, 20)]);
  // Give the fragment metric some drafted spread so σ is non-zero and an exemplar
  // re-center can actually flag: issues vary their fragment counts.
  const draftedSpread = manuscriptOf([
    `${issueBlock(3, 20)} ${issueBlock(1, 3)}`,
    `${issueBlock(3, 20)} ${issueBlock(2, 3)}`,
    `${issueBlock(3, 20)} ${issueBlock(1, 3)}`,
    `${issueBlock(3, 20)} ${issueBlock(6, 3)}`,
  ]);
  const shortExemplars = [
    { passage: issueBlock(6, 5), note: 'spare' },
    { passage: issueBlock(6, 5) },
  ];

  it('drafted mode is the default and ignores exemplars', () => {
    const drift = computeVoiceDrift(draftedUniform, { voiceExemplars: shortExemplars });
    expect(drift.baselineMode).toBe('drafted');
    expect(drift.exemplarBaselineUsed).toBe(false);
    // sentence-length σ is 0 across identical issues → no outlier on that metric.
    expect(drift.outliers.some((o) => o.metricKey === 'sentenceLenMean')).toBe(false);
  });

  it('exemplars mode re-centers on the chosen voice and reports it', () => {
    const drift = computeVoiceDrift(draftedSpread, {
      baselineMode: 'exemplars',
      voiceExemplars: shortExemplars,
    });
    expect(drift.baselineMode).toBe('exemplars');
    expect(drift.exemplarBaselineUsed).toBe(true);
    // The chosen-voice sentence-length mean (~5) is the center, not the drafted
    // mean (~15.75); every drafted issue sits well above it.
    expect(drift.series.sentenceLenMean.center).toBeCloseTo(5, 1);
    expect(drift.series.sentenceLenMean.mean).toBeGreaterThan(10);
    const meanOutliers = drift.outliers.filter((o) => o.metricKey === 'sentenceLenMean');
    expect(meanOutliers.length).toBeGreaterThan(0);
    expect(meanOutliers.every((o) => o.direction === 'high')).toBe(true);
    expect(meanOutliers.every((o) => o.baselineMode === 'exemplars')).toBe(true);
  });

  it('blended mode centers on the midpoint of drafted mean and chosen voice', () => {
    const drift = computeVoiceDrift(draftedSpread, {
      baselineMode: 'blended',
      voiceExemplars: shortExemplars,
    });
    expect(drift.baselineMode).toBe('blended');
    const s = drift.series.sentenceLenMean;
    // center = (draftedMean + exemplarMean) / 2.
    expect(s.center).toBeCloseTo((s.mean + 5) / 2, 1);
  });

  it('falls back to drafted when the exemplar set is too thin', () => {
    const drift = computeVoiceDrift(draftedSpread, {
      baselineMode: 'exemplars',
      voiceExemplars: [{ passage: issueBlock(1, 4) }], // < 40 words
    });
    expect(drift.baselineMode).toBe('drafted');
    expect(drift.exemplarBaselineUsed).toBe(false);
  });

  it('falls back to drafted when no exemplars are provided', () => {
    const drift = computeVoiceDrift(draftedSpread, { baselineMode: 'exemplars' });
    expect(drift.baselineMode).toBe('drafted');
    expect(drift.exemplarBaselineUsed).toBe(false);
  });

  it('coerces an unrecognized baselineMode to drafted', () => {
    const drift = computeVoiceDrift(draftedSpread, { baselineMode: 'nonsense', voiceExemplars: shortExemplars });
    expect(drift.baselineMode).toBe('drafted');
  });

  it('exposes the three valid modes', () => {
    expect(VOICE_BASELINE_MODES).toEqual(['drafted', 'exemplars', 'blended']);
  });

  it('gates off below minIssues regardless of baseline mode', () => {
    const ms = manuscriptOf([issueBlock(3, 20), issueBlock(3, 20)]);
    const drift = computeVoiceDrift(ms, { baselineMode: 'exemplars', voiceExemplars: shortExemplars });
    expect(drift.gatedOff).toBe(true);
    // Effective mode is still reported so the UI can label the (empty) run.
    expect(drift.baselineMode).toBe('exemplars');
  });
});

describe('computeVoiceDrift series-level findings (#2248)', () => {
  // Four IDENTICAL dialogue-free issues → σ≈0 on every metric, so the per-issue
  // z-score model emits no outlier. dialogueRatio is 0 on every issue.
  const dialogueFree = manuscriptOf([issueBlock(4, 20), issueBlock(4, 20), issueBlock(4, 20), issueBlock(4, 20)]);
  // A dialogue-heavy chosen voice: 6 quoted spans of 8 words each → ~48 words,
  // nearly all inside quotes, so the exemplar dialogueRatio is very high. Two
  // copies clear the 40-word exemplar floor comfortably.
  const quotedSpan = `"${Array.from({ length: 8 }, (_, j) => `d${j}`).join(' ')}."`;
  const dialogueExemplarPassage = Array.from({ length: 6 }, () => quotedSpan).join(' ');
  const dialogueExemplars = [
    { passage: dialogueExemplarPassage, note: 'chatty' },
    { passage: dialogueExemplarPassage },
  ];

  it('drafted mode never emits a series-level finding (center === mean)', () => {
    const drift = computeVoiceDrift(dialogueFree, { voiceExemplars: dialogueExemplars });
    expect(drift.baselineMode).toBe('drafted');
    expect(drift.seriesFindings).toEqual([]);
  });

  it('flags a uniformly-off-register metric under the exemplar baseline', () => {
    const drift = computeVoiceDrift(dialogueFree, {
      baselineMode: 'exemplars',
      voiceExemplars: dialogueExemplars,
    });
    expect(drift.exemplarBaselineUsed).toBe(true);
    // dialogueRatio: every issue is 0 (σ≈0) but the chosen voice is dialogue-heavy,
    // so there's no per-issue outlier — it surfaces as a series-level finding.
    expect(drift.outliers.some((o) => o.metricKey === 'dialogueRatio')).toBe(false);
    const dlg = drift.seriesFindings.find((f) => f.metricKey === 'dialogueRatio');
    expect(dlg).toBeTruthy();
    expect(dlg.mean).toBe(0);
    expect(dlg.center).toBeGreaterThan(0);
    expect(dlg.direction).toBe('low'); // the corpus uses LESS dialogue than the voice
    expect(dlg.distance).toBeGreaterThanOrEqual(0.5);
    expect(dlg.baselineMode).toBe('exemplars');
    // No `issue` field — it's a corpus-wide finding, not a per-issue outlier.
    expect(dlg.issue).toBeUndefined();
  });

  it('sorts series findings by distance descending', () => {
    const drift = computeVoiceDrift(dialogueFree, {
      baselineMode: 'exemplars',
      voiceExemplars: dialogueExemplars,
    });
    const distances = drift.seriesFindings.map((f) => f.distance);
    const sorted = [...distances].sort((a, b) => b - a);
    expect(distances).toEqual(sorted);
  });

  it('respects a custom seriesDistanceThreshold (relative distance maxes at 1)', () => {
    const drift = computeVoiceDrift(dialogueFree, {
      baselineMode: 'exemplars',
      voiceExemplars: dialogueExemplars,
      seriesDistanceThreshold: 2, // unreachable — relative distance is in [0, 1]
    });
    expect(drift.seriesFindings).toEqual([]);
  });

  it('does not flag a metric that already produces per-issue outliers (σ>0)', () => {
    // draftedSpread from the baseline-modes block: fragment metric has σ>0, so it
    // flows through the per-issue path, not the series-level branch.
    const spread = manuscriptOf([
      `${issueBlock(3, 20)} ${issueBlock(1, 3)}`,
      `${issueBlock(3, 20)} ${issueBlock(2, 3)}`,
      `${issueBlock(3, 20)} ${issueBlock(1, 3)}`,
      `${issueBlock(3, 20)} ${issueBlock(6, 3)}`,
    ]);
    const drift = computeVoiceDrift(spread, {
      baselineMode: 'exemplars',
      voiceExemplars: [{ passage: issueBlock(6, 5) }, { passage: issueBlock(6, 5) }],
    });
    // fragmentPct has drafted spread, so it never appears as a series-level finding.
    expect(drift.seriesFindings.some((f) => f.metricKey === 'fragmentPct')).toBe(false);
  });

  it('gatedOff runs report an empty seriesFindings array', () => {
    const ms = manuscriptOf([issueBlock(3, 20), issueBlock(3, 20)]);
    const drift = computeVoiceDrift(ms, { baselineMode: 'exemplars', voiceExemplars: dialogueExemplars });
    expect(drift.gatedOff).toBe(true);
    expect(drift.seriesFindings).toEqual([]);
  });

  it('describeSeriesDrift names the metric, corpus value, chosen-voice center, and direction', () => {
    const f = {
      metricKey: 'dialogueRatio', label: 'dialogue ratio',
      mean: 0, center: 42.5, std: 0, distance: 1, direction: 'low', unit: '%',
      baselineMode: 'exemplars',
    };
    const text = describeSeriesDrift(f);
    expect(text).toContain('The whole series');
    expect(text).toContain('0%');
    expect(text).toContain('42.5%');
    expect(text).toContain("the style guide's chosen voice");
    expect(text).toContain('below');
    expect(text).toContain('narration-driven'); // the "lower" phrase for dialogue ratio
  });

  it('describeSeriesDrift labels a blended baseline as the blend', () => {
    const f = {
      metricKey: 'dialogueRatio', label: 'dialogue ratio',
      mean: 0, center: 20, std: 0, distance: 1, direction: 'low', unit: '%',
      baselineMode: 'blended',
    };
    expect(describeSeriesDrift(f)).toContain('the blend of the series mean and the chosen voice');
  });
});

describe('describeDrift + renderFingerprintTable', () => {
  it('describeDrift names the issue, values, σ, and direction', () => {
    const o = {
      issue: 7, metricKey: 'sentenceLenCV', label: 'sentence-length variation (CV)',
      value: 0.18, mean: 0.41, std: 0.1, z: -2.3, direction: 'low', unit: '',
    };
    const text = describeDrift(o);
    expect(text).toContain('Issue 7');
    expect(text).toContain('0.18');
    expect(text).toContain('0.41');
    expect(text).toContain('the series mean'); // default (drafted) baseline noun
    expect(text).toContain('metronomic'); // the "lower" phrase for CV
    expect(text).toContain('below');
  });

  it('describeDrift labels the baseline as the chosen voice in exemplars mode (#2179)', () => {
    const o = {
      issue: 7, metricKey: 'sentenceLenMean', label: 'sentence-length mean',
      value: 20, mean: 15, center: 5, std: 4, z: 3.75, direction: 'high', unit: ' words',
      baselineMode: 'exemplars',
    };
    const text = describeDrift(o);
    expect(text).toContain("the style guide's chosen voice");
    expect(text).toContain('5 words'); // the center, not the drafted mean of 15
    expect(text).not.toContain('the series mean of');
  });

  it('renderFingerprintTable renders rows, mean/σ, and marks outliers with *', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 20)]);
    const drift = computeVoiceDrift(ms);
    const table = renderFingerprintTable(drift);
    expect(table).toContain('#4');
    expect(table).toContain('mean');
    expect(table).toContain('σ');
    expect(table).toContain('*'); // issue 4's outlier cell is starred
  });

  it('metricLabel resolves static metrics and wells', () => {
    expect(metricLabel('sentenceLenMean')).toBe('sentence-length mean');
    expect(metricLabel('well:trade')).toContain('trade');
  });
});

describe('style.voice-drift check (registry wiring)', () => {
  const runCheck = (ms, config = {}, severityDefault = 'low', series = undefined) => {
    const check = getCheck('style.voice-drift');
    expect(check).toBeTruthy();
    return check.run({ manuscript: ms, config, severityDefault, series });
  };

  it('is registered as a deterministic series check', () => {
    const check = getCheck('style.voice-drift');
    expect(check.scope).toBe('series');
    expect(check.kind).toBe('deterministic');
    expect(check.needsManuscript).toBe(true);
  });

  it('declares series.styleGuide as a source so exemplar edits re-stale it (#2179)', () => {
    const check = getCheck('style.voice-drift');
    expect(check.sources).toContain('series.styleGuide');
    // The config schema advertises the baselineMode field.
    const parsed = check.configSchema.parse({ baselineMode: 'exemplars' });
    expect(parsed.baselineMode).toBe('exemplars');
    // An unrecognized value is coerced to drafted rather than failing the parse.
    expect(check.configSchema.parse({ baselineMode: 'bogus' }).baselineMode).toBe('drafted');
  });

  it('measures against the style guide voice exemplars when configured (#2179)', () => {
    // Drafted issues cluster tightly at a long sentence-length mean (14/15/15/16
    // words → drafted σ ≈ 0.71, so the biggest drafted-mode z ≈ 1.41 < 1.5 → no
    // drafted flag). The chosen voice is much shorter (mean 5), so against the
    // exemplar baseline every drafted issue is a wild outlier the drafted mean hid.
    const ms = manuscriptOf([issueBlock(4, 14), issueBlock(4, 15), issueBlock(4, 15), issueBlock(4, 16)]);
    const series = { styleGuide: { voiceExemplars: [{ passage: issueBlock(6, 5) }, { passage: issueBlock(6, 5) }] } };
    const drafted = runCheck(ms, { baselineMode: 'drafted' }, 'low', series);
    const exemplars = runCheck(ms, { baselineMode: 'exemplars' }, 'low', series);
    // The exemplar baseline surfaces sentence-length drift the drafted mean hides.
    expect(drafted.some((f) => f.problem.includes('sentence-length mean'))).toBe(false);
    const meanFinding = exemplars.find((f) => f.problem.includes('sentence-length mean'));
    expect(meanFinding).toBeTruthy();
    expect(meanFinding.problem).toContain("the style guide's chosen voice");
  });

  it('emits findings anchored to the drifting issue', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 20)]);
    const findings = runCheck(ms);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.issueNumber === 4)).toBe(true);
    expect(findings.every((f) => f.category === 'style')).toBe(true);
    expect(findings[0].location).toContain('Issue 4');
  });

  it('gates off (no findings) below the minIssues default of 4', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 20)]);
    expect(runCheck(ms)).toEqual([]);
  });

  it('caps findings at maxFindings, most significant first', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 40)]);
    const findings = runCheck(ms, { maxFindings: 1 });
    expect(findings).toHaveLength(1);
  });

  it('escalates a strong (≥2.5σ) outlier above the low floor', () => {
    // 8 issues, one drifting → z = √7 ≈ 2.646 (≥ 2.5) → severity escalates low→medium.
    const blocks = [...Array(7).fill(issueBlock(3, 5)), issueBlock(3, 20)];
    const ms = manuscriptOf(blocks);
    const findings = runCheck(ms);
    const meanFinding = findings.find((f) => f.problem.includes('sentence-length mean'));
    expect(meanFinding).toBeTruthy();
    expect(meanFinding.severity).toBe('medium');
    expect(meanFinding.issueNumber).toBe(8);
  });

  it('emits a series-wide finding (issueNumber null) for a uniformly off-register metric (#2248)', () => {
    // Four identical dialogue-free issues → σ≈0 everywhere, no per-issue outlier.
    const ms = manuscriptOf([issueBlock(4, 20), issueBlock(4, 20), issueBlock(4, 20), issueBlock(4, 20)]);
    const quotedSpan = `"${Array.from({ length: 8 }, (_, j) => `d${j}`).join(' ')}."`;
    const passage = Array.from({ length: 6 }, () => quotedSpan).join(' ');
    const series = { styleGuide: { voiceExemplars: [{ passage }, { passage }] } };
    const findings = runCheck(ms, { baselineMode: 'exemplars' }, 'low', series);
    const seriesLevel = findings.find((f) => f.problem.includes('The whole series') && f.problem.includes('dialogue ratio'));
    expect(seriesLevel).toBeTruthy();
    expect(seriesLevel.issueNumber).toBeNull();
    expect(seriesLevel.location).toContain('Series-wide');
    // A corpus-wide mismatch escalates one rank above the low floor.
    expect(seriesLevel.severity).toBe('medium');
    // Drafted mode never produces it (center === mean).
    const drafted = runCheck(ms, { baselineMode: 'drafted' }, 'low', series);
    expect(drafted.some((f) => f.problem.includes('The whole series'))).toBe(false);
  });
});
