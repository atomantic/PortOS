import { describe, it, expect } from 'vitest';
import {
  VOICE_METRICS,
  parseVoiceWells,
  computeFingerprint,
  splitManuscriptByIssue,
  voiceFingerprintMatrix,
  computeVoiceDrift,
  describeDrift,
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
    expect(text).toContain('metronomic'); // the "lower" phrase for CV
    expect(text).toContain('below');
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
  const runCheck = (ms, config = {}, severityDefault = 'low') => {
    const check = getCheck('style.voice-drift');
    expect(check).toBeTruthy();
    return check.run({ manuscript: ms, config, severityDefault });
  };

  it('is registered as a deterministic series check', () => {
    const check = getCheck('style.voice-drift');
    expect(check.scope).toBe('series');
    expect(check.kind).toBe('deterministic');
    expect(check.needsManuscript).toBe(true);
  });

  it('emits findings anchored to the drifting issue', () => {
    const ms = manuscriptOf([issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 5), issueBlock(3, 20)]);
    const findings = runCheck(ms);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.issueNumber === 4)).toBe(true);
    expect(findings.every((f) => f.category === 'style')).toBe(true);
    expect(findings[0].location).toContain('Issue 4');
  });

  it('gates off (no findings) below 3 issues', () => {
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
});
