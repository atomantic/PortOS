import { describe, it, expect } from 'vitest';
import {
  ASSESSMENT_INTENTS,
  FIT_VERDICTS,
  classifyFitVerdict,
  classifySampleFailure,
  explainAssessment,
  maxWorkingContextTokens,
  parseParamsBillions,
  rankByIntent,
  scoreAssessment,
  scoreForIntent,
  summarizePerformance,
  buildThroughputReport,
  selectSweepTargets,
  summarizeSweepScopes,
  compareEnvironments,
  describeStaleness,
  measuredFitVerdict,
  reconcileFit,
} from './localModelAssessment.js';

const okSample = (contextTokens, charsPerSecond, ttftMs = 300) => ({
  contextTokens, ok: true, charsPerSecond, ttftMs, totalMs: 1000, chars: 40, error: null,
});
const failSample = (contextTokens, error) => ({
  contextTokens, ok: false, charsPerSecond: null, ttftMs: null, totalMs: null, chars: null, error,
});

describe('classifySampleFailure', () => {
  it('returns null for a sample that succeeded', () => {
    expect(classifySampleFailure(okSample(512, 100))).toBeNull();
  });

  it('distinguishes an architecture refusal from resource exhaustion', () => {
    expect(classifySampleFailure(failSample(512, 'unknown model architecture: mamba2'))).toBe('incompatible');
    expect(classifySampleFailure(failSample(512, 'model requires more system memory (42.0 GiB) than is available'))).toBe('resource');
  });

  it('treats a timeout as resource exhaustion, not incompatibility', () => {
    expect(classifySampleFailure(failSample(16384, 'Timed out after 120000ms'))).toBe('resource');
  });

  it('refuses to guess when the failure carries no error text', () => {
    // A failed sample with no message is NOT evidence of anything — guessing
    // here would produce a permanent `does-not-fit` from a transient blip.
    expect(classifySampleFailure({ ok: false })).toBeNull();
    expect(classifySampleFailure({ ok: false, error: 'connection reset by peer' })).toBeNull();
  });
});

describe('classifyFitVerdict', () => {
  it('is unknown with no samples — never "does not fit"', () => {
    expect(classifyFitVerdict([])).toBe('unknown');
    expect(classifyFitVerdict(undefined)).toBe('unknown');
  });

  it('fits when any context length succeeded, even if a larger one failed', () => {
    const samples = [okSample(512, 120), okSample(4096, 60), failSample(16384, 'out of memory')];
    expect(classifyFitVerdict(samples)).toBe('fits');
  });

  it('reports incompatible ahead of does-not-fit — it is the actionable one', () => {
    const samples = [failSample(512, 'cannot allocate memory'), failSample(4096, 'unsupported model format')];
    expect(classifyFitVerdict(samples)).toBe('incompatible');
  });

  it('reports does-not-fit only when a failure is identifiably about resources', () => {
    expect(classifyFitVerdict([failSample(512, 'not enough memory to load model')])).toBe('does-not-fit');
  });

  it('stays unknown when every run failed for an unattributable reason', () => {
    // A network blip is not evidence about hardware fit. Collapsing it into
    // does-not-fit would permanently mislabel a perfectly good model.
    expect(classifyFitVerdict([failSample(512, 'socket hang up')])).toBe('unknown');
  });

  it('only ever emits documented verdicts', () => {
    const cases = [[], [okSample(1, 1)], [failSample(1, 'oom')], [failSample(1, 'unsupported')], [failSample(1, '?')]];
    for (const samples of cases) expect(FIT_VERDICTS).toContain(classifyFitVerdict(samples));
  });
});

describe('maxWorkingContextTokens', () => {
  it('reports the largest SUCCESSFUL context, ignoring failures at larger sizes', () => {
    expect(maxWorkingContextTokens([okSample(512, 100), okSample(4096, 50), failSample(16384, 'oom')])).toBe(4096);
  });

  it('is null — not 0 — when nothing succeeded', () => {
    expect(maxWorkingContextTokens([failSample(512, 'oom')])).toBeNull();
  });
});

describe('summarizePerformance', () => {
  it('averages only successful samples and reports the degradation trend', () => {
    const perf = summarizePerformance([okSample(512, 200, 100), okSample(4096, 100, 400), failSample(16384, 'oom')]);
    expect(perf.samplesRun).toBe(3);
    expect(perf.samplesOk).toBe(2);
    expect(perf.meanCharsPerSecond).toBe(150);
    expect(perf.meanTtftMs).toBe(250);
    expect(perf.peakCharsPerSecond).toBe(200);
    expect(perf.contextDegradation).toBe(0.5);
  });

  it('measures degradation at the LONGEST context, not at the slowest sample', () => {
    // Results are not monotonic in practice. A mid-range dip must not be
    // reported as the long-context behavior — the number is rendered as
    // "held X% of peak at its longest context", so it has to mean that.
    const perf = summarizePerformance([okSample(512, 100), okSample(4096, 50), okSample(16384, 80)]);
    expect(perf.contextDegradation).toBe(0.8);
  });

  it('clamps degradation at 1 when the longest context measured above the others', () => {
    expect(summarizePerformance([okSample(512, 80), okSample(4096, 100)]).contextDegradation).toBe(1);
  });

  it('does not fake a degradation trend from a single sample', () => {
    // Reporting 1 here would claim "throughput held flat across contexts" on
    // the strength of one data point.
    expect(summarizePerformance([okSample(512, 200)]).contextDegradation).toBeNull();
  });

  it('reports nulls, not zeros, when nothing was measured', () => {
    const perf = summarizePerformance([failSample(512, 'oom')]);
    expect(perf.meanCharsPerSecond).toBeNull();
    expect(perf.meanTtftMs).toBeNull();
    expect(perf.peakCharsPerSecond).toBeNull();
    expect(perf.maxWorkingContextTokens).toBeNull();
    expect(perf.samplesOk).toBe(0);
  });
});

describe('parseParamsBillions', () => {
  it('reads a size from the params field or the model id', () => {
    expect(parseParamsBillions({ params: '32B' })).toBe(32);
    expect(parseParamsBillions({ modelId: 'example-model:14b' })).toBe(14);
    expect(parseParamsBillions({ modelId: 'example-model:1.5b' })).toBe(1.5);
  });

  it('is null when no size marker exists — never defaulted to a small model', () => {
    expect(parseParamsBillions({ modelId: 'example-model:latest' })).toBeNull();
    expect(parseParamsBillions({})).toBeNull();
  });
});

describe('scoreAssessment', () => {
  const base = {
    modelId: 'example-model:14b',
    performance: { meanCharsPerSecond: 120, contextDegradation: 0.8 },
    residentGb: 10,
    environment: { memoryBudgetGb: 40 },
  };

  it('scores every axis that has evidence', () => {
    const scores = scoreAssessment(base);
    expect(scores.capability).toBeGreaterThan(0);
    expect(scores.speed).toBeCloseTo(0.5, 5);
    expect(scores.fidelity).toBeCloseTo(0.8, 5);
    expect(scores.memory).toBeCloseTo(0.75, 5);
  });

  it('caps speed at the interactive anchor rather than rewarding runaway numbers', () => {
    expect(scoreAssessment({ ...base, performance: { meanCharsPerSecond: 5000 } }).speed).toBe(1);
  });

  it('leaves an unmeasured axis null instead of scoring it 0', () => {
    const scores = scoreAssessment({ modelId: 'example-model:latest', performance: {}, environment: {} });
    expect(scores.capability).toBeNull();
    expect(scores.speed).toBeNull();
    expect(scores.fidelity).toBeNull();
    expect(scores.memory).toBeNull();
  });

  it('leaves memory null when the budget probe failed, rather than assuming no headroom', () => {
    expect(scoreAssessment({ ...base, environment: { memoryBudgetGb: null } }).memory).toBeNull();
  });
});

describe('scoreForIntent', () => {
  const full = { capability: 0.5, speed: 0.5, fidelity: 0.5, memory: 0.5 };

  it('produces the same score for uniform axes under every intent', () => {
    for (const intent of ASSESSMENT_INTENTS) {
      expect(scoreForIntent(full, intent).score).toBeCloseTo(0.5, 5);
    }
  });

  it('weights the intent it is asked for', () => {
    const fast = { capability: 0, speed: 1, fidelity: 0, memory: 0 };
    expect(scoreForIntent(fast, 'fastest').score).toBeGreaterThan(scoreForIntent(fast, 'smartest').score);
  });

  it('renormalizes over measured axes instead of penalizing missing evidence', () => {
    // Speed-only evidence at 1.0 should score 1.0 — not 0.3 (its balanced
    // weight), which would make a partly-measured model look mediocre.
    const partial = { capability: null, speed: 1, fidelity: null, memory: null };
    const result = scoreForIntent(partial, 'balanced');
    expect(result.score).toBe(1);
    expect(result.coverage).toBe(0.3);
  });

  it('is null — not 0 — when no axis was measured', () => {
    expect(scoreForIntent({ capability: null, speed: null, fidelity: null, memory: null }, 'balanced'))
      .toEqual({ score: null, coverage: 0 });
  });

  it('falls back to balanced weights for an unrecognized intent', () => {
    expect(scoreForIntent(full, 'nonsense').score).toBeCloseTo(0.5, 5);
  });
});

describe('explainAssessment', () => {
  it('names only measured numbers', () => {
    const text = explainAssessment({
      performance: { meanCharsPerSecond: 120, maxWorkingContextTokens: 4096, contextDegradation: 0.8 },
      residentGb: 10,
    }, 'balanced');
    expect(text).toContain('120 chars/s measured');
    expect(text).toContain('4,096 tokens');
    expect(text).toContain('80% of peak');
    expect(text).toContain('10 GB resident');
  });

  it('omits an unmeasured axis rather than describing it', () => {
    const text = explainAssessment({ performance: { meanCharsPerSecond: 120 }, residentGb: null }, 'fastest');
    expect(text).toBe('120 chars/s measured.');
  });

  it('says so plainly when nothing was measured', () => {
    expect(explainAssessment({ performance: {} }, 'smartest')).toMatch(/No measurements recorded/);
  });
});

// The tuning IS the row's identity when a model holds several measurements. The
// consumer keys the row on it, deletes THIS measurement with it, and pre-fills a
// re-measure from it — so a projection that drops it collapses every variant
// onto the backend-defaults record (wrong row deleted, re-measure loses its
// settings, duplicate React keys).
describe('rankByIntent — tuning identity', () => {
  const tuned = (tuningKey, tuning, tuningLabel, charsPerSecond) => ({
    backend: 'llama',
    modelId: 'example-7b',
    verdict: 'fits',
    params: '7B',
    tuningKey,
    tuning,
    tuningLabel,
    performance: { meanCharsPerSecond: charsPerSecond, contextDegradation: 0.9, maxWorkingContextTokens: 16384 },
    environment: { memoryBudgetGb: 64 },
    residentGb: 5,
  });

  it('carries the tuning through to every ranked row', () => {
    const { ranked } = rankByIntent([
      tuned('', {}, null, 90),
      tuned('ubatchSize=512', { ubatchSize: 512 }, 'Micro-batch size 512', 120),
    ], 'fastest');
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.tuningKey).sort()).toEqual(['', 'ubatchSize=512']);
    const fastest = ranked[0];
    expect(fastest.tuningKey).toBe('ubatchSize=512');
    expect(fastest.tuning).toEqual({ ubatchSize: 512 });
    expect(fastest.tuningLabel).toBe('Micro-batch size 512');
  });

  it('gives two tunings of one model distinct identities, not one collapsed row', () => {
    const { ranked } = rankByIntent([
      tuned('', {}, null, 90),
      tuned('ubatchSize=512', { ubatchSize: 512 }, 'Micro-batch size 512', 120),
    ], 'fastest');
    const keys = ranked.map((r) => `${r.backend}:${r.modelId}@${r.tuningKey}`);
    expect(new Set(keys).size).toBe(2);
  });

  it('reports that a tuning was not applied so the row can say the numbers are another config', () => {
    const entry = tuned('ubatchSize=512', { ubatchSize: 512 }, 'Micro-batch size 512', 120);
    const { ranked } = rankByIntent([
      { ...entry, tuningApplied: false, tuningNotApplied: 'llama-server is not running' },
    ], 'fastest');
    expect(ranked[0].tuningApplied).toBe(false);
    expect(ranked[0].tuningNotApplied).toBe('llama-server is not running');
  });

  it('breaks a model-id tie on the tuning so the order is stable across reloads', () => {
    const a = tuned('a=1', {}, 'A', 100);
    const b = tuned('b=2', { }, 'B', 100);
    expect(rankByIntent([b, a], 'fastest').ranked.map((r) => r.tuningKey)).toEqual(['a=1', 'b=2']);
    expect(rankByIntent([a, b], 'fastest').ranked.map((r) => r.tuningKey)).toEqual(['a=1', 'b=2']);
  });

  it('carries the tuning onto an excluded row too, so variants stay distinguishable there', () => {
    const { excluded } = rankByIntent([
      { ...tuned('ubatchSize=512', { ubatchSize: 512 }, 'Micro-batch size 512', 120), verdict: 'does-not-fit' },
    ], 'fastest');
    expect(excluded[0].tuningKey).toBe('ubatchSize=512');
    expect(excluded[0].tuningLabel).toBe('Micro-batch size 512');
  });
});

describe('rankByIntent', () => {
  const assessment = (modelId, verdict, performance, extra = {}) => ({
    backend: 'ollama',
    modelId,
    verdict,
    performance,
    environment: { memoryBudgetGb: 40 },
    ...extra,
  });

  it('ranks a faster model first for "fastest" and a bigger one first for "smartest"', () => {
    const models = [
      assessment('example-small:7b', 'fits', { meanCharsPerSecond: 240, contextDegradation: 1 }, { residentGb: 5 }),
      assessment('example-large:70b', 'fits', { meanCharsPerSecond: 30, contextDegradation: 1 }, { residentGb: 38 }),
    ];
    expect(rankByIntent(models, 'fastest').ranked[0].modelId).toBe('example-small:7b');
    expect(rankByIntent(models, 'smartest').ranked[0].modelId).toBe('example-large:70b');
  });

  it('favors the lightest resident footprint for "lightweight"', () => {
    const models = [
      assessment('example-large:70b', 'fits', { meanCharsPerSecond: 60, contextDegradation: 1 }, { residentGb: 38 }),
      assessment('example-small:7b', 'fits', { meanCharsPerSecond: 60, contextDegradation: 1 }, { residentGb: 5 }),
    ];
    expect(rankByIntent(models, 'lightweight').ranked[0].modelId).toBe('example-small:7b');
  });

  it('never ranks a model that did not run, and explains why it was left out', () => {
    const models = [
      assessment('example-model:70b', 'does-not-fit', { meanCharsPerSecond: null }, { verdictReason: 'out of memory' }),
      assessment('example-model:7b', 'fits', { meanCharsPerSecond: 120, contextDegradation: 1 }, { residentGb: 5 }),
    ];
    const { ranked, excluded } = rankByIntent(models, 'balanced');
    expect(ranked.map((r) => r.modelId)).toEqual(['example-model:7b']);
    expect(excluded).toEqual([
      { backend: 'ollama', modelId: 'example-model:70b', tuningKey: '', tuningLabel: null, verdict: 'does-not-fit', reason: 'out of memory' },
    ]);
  });

  it('excludes a "fits" model whose intent axes were never measured, rather than ranking it last', () => {
    // Scoring it 0 would put a working-but-unmeasured model below a measured-bad
    // one, which is the exact confusion this feature removes.
    const models = [assessment('example-model:latest', 'fits', {})];
    const { ranked, excluded } = rankByIntent(models, 'balanced');
    expect(ranked).toEqual([]);
    expect(excluded[0].reason).toMatch(/no axis of this intent was measured/);
  });

  it('breaks a score tie on evidence coverage, so a fully-measured model wins', () => {
    const measured = assessment('example-b:7b', 'fits', { meanCharsPerSecond: 120, contextDegradation: 1 }, { residentGb: 20 });
    const partial = assessment('example-a:7b', 'fits', { meanCharsPerSecond: 120 });
    const { ranked } = rankByIntent([partial, measured], 'balanced');
    expect(ranked[0].coverage).toBeGreaterThan(ranked[1].coverage);
  });

  it('carries the measured resident size into the ranked entry', () => {
    // The memory axis is scored FROM residentGb, so dropping it from the entry
    // makes a consumer render "not measured" for a value that was measured.
    const models = [assessment('example-model:7b', 'fits', { meanCharsPerSecond: 120, contextDegradation: 1 }, { residentGb: 5, params: '7B' })];
    const { ranked } = rankByIntent(models, 'balanced');
    expect(ranked[0].residentGb).toBe(5);
    expect(ranked[0].params).toBe('7B');
  });

  it('keeps residentGb null when it was never measured', () => {
    const models = [assessment('example-model:7b', 'fits', { meanCharsPerSecond: 120, contextDegradation: 1 })];
    expect(rankByIntent(models, 'balanced').ranked[0].residentGb).toBeNull();
  });

  it('is empty and safe on no input', () => {
    expect(rankByIntent(undefined, 'balanced')).toEqual({ intent: 'balanced', ranked: [], excluded: [] });
  });

  it('falls back to the balanced intent for an unknown one', () => {
    expect(rankByIntent([], 'nonsense').intent).toBe('balanced');
  });
});

describe('compareEnvironments', () => {
  const recorded = { platform: 'darwin', arch: 'arm64', cpuCount: 12, totalMemoryGb: 64, backendVersion: '1.2.3' };

  it('reports current when every comparable field matches', () => {
    expect(compareEnvironments(recorded, { ...recorded })).toEqual({ comparable: true, stale: false, changes: [] });
  });

  it('flags a RAM change — the case the badge exists for', () => {
    const result = compareEnvironments(recorded, { ...recorded, totalMemoryGb: 128 });
    expect(result.stale).toBe(true);
    expect(result.changes).toEqual([{ field: 'totalMemoryGb', label: 'installed memory', from: 64, to: 128 }]);
    expect(describeStaleness(result)).toContain('installed memory 64 → 128');
  });

  it('flags a backend update', () => {
    const result = compareEnvironments(recorded, { ...recorded, backendVersion: '1.3.0' });
    expect(result.stale).toBe(true);
    expect(result.changes[0].field).toBe('backendVersion');
  });

  it('ignores sub-tolerance memory reporting jitter', () => {
    expect(compareEnvironments(recorded, { ...recorded, totalMemoryGb: 64.3 }).stale).toBe(false);
  });

  it('never treats a field absent on either side as a change', () => {
    // Records written before `backendVersion` was captured, and LM Studio (which
    // exposes no version at all), must not read as "the backend changed".
    const legacy = { platform: 'darwin', arch: 'arm64', cpuCount: 12, totalMemoryGb: 64 };
    const result = compareEnvironments(legacy, { ...legacy, backendVersion: '1.3.0' });
    expect(result.stale).toBe(false);
    expect(result.comparable).toBe(true);
  });

  it('reports not-comparable rather than fresh when there is nothing to compare', () => {
    // `comparable: false` is UNKNOWN. A caller must not render it as a clean bill
    // of health — that is the absent-vs-empty sentinel rule.
    expect(compareEnvironments(null, null)).toEqual({ comparable: false, stale: false, changes: [] });
    expect(describeStaleness({ comparable: false, stale: false, changes: [] })).toBeNull();
  });

  it('does not compare transient available memory, which swings constantly', () => {
    const result = compareEnvironments(
      { ...recorded, availableMemoryGb: 40, memoryBudgetGb: 40 },
      { ...recorded, availableMemoryGb: 3, memoryBudgetGb: 3 },
    );
    expect(result.stale).toBe(false);
  });
});

describe('measuredFitVerdict', () => {
  it('reads a comfortable fit when the footprint is well under the budget', () => {
    expect(measuredFitVerdict({
      verdict: 'fits', residentGb: 8, environment: { memoryBudgetGb: 40 },
    })).toBe('comfortable');
  });

  it('reads tight past the same 60% threshold the estimate uses', () => {
    expect(measuredFitVerdict({
      verdict: 'fits', residentGb: 30, environment: { memoryBudgetGb: 40 },
    })).toBe('tight');
  });

  it('says comfortable when it ran but the footprint is unmeasured (LM Studio)', () => {
    expect(measuredFitVerdict({ verdict: 'fits', residentGb: null, environment: {} })).toBe('comfortable');
  });

  it('maps the failure verdicts onto the badge vocabulary', () => {
    expect(measuredFitVerdict({ verdict: 'does-not-fit' })).toBe('too-large');
    expect(measuredFitVerdict({ verdict: 'incompatible' })).toBe('incompatible');
  });

  it('says nothing at all for an unknown verdict or a missing assessment', () => {
    // null ≠ 'unknown': 'unknown' is a badge the ESTIMATE also produces, so
    // collapsing them would make an unmeasured model look measured.
    expect(measuredFitVerdict({ verdict: 'unknown' })).toBeNull();
    expect(measuredFitVerdict(null)).toBeNull();
  });
});

describe('reconcileFit', () => {
  const measurement = { fit: 'too-large', verdict: 'does-not-fit', assessedAt: '2026-01-02T00:00:00.000Z', stale: false };

  it('leaves the estimate alone when nothing was measured', () => {
    const result = reconcileFit('comfortable', null);
    expect(result).toMatchObject({ fit: 'comfortable', fitSource: 'estimated', measuredFit: null, disagrees: false });
  });

  it('prefers the measurement and records the disagreement', () => {
    const result = reconcileFit('comfortable', measurement);
    expect(result).toMatchObject({
      fit: 'too-large',
      fitSource: 'measured',
      estimatedFit: 'comfortable',
      measuredFit: 'too-large',
      disagrees: true,
      verdict: 'does-not-fit',
    });
  });

  it('does not flag a disagreement when both sides agree', () => {
    expect(reconcileFit('too-large', measurement).disagrees).toBe(false);
  });

  it('keeps the estimate when the measurement is stale, but still reports it', () => {
    const result = reconcileFit('comfortable', { ...measurement, stale: true, staleReason: 'RAM changed' });
    expect(result.fit).toBe('comfortable');
    expect(result.fitSource).toBe('estimated');
    expect(result.measuredFit).toBe('too-large');
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe('RAM changed');
  });

  it('does not claim a disagreement against an unknown estimate', () => {
    expect(reconcileFit('unknown', measurement).disagrees).toBe(false);
    expect(reconcileFit(null, measurement)).toMatchObject({ fit: 'too-large', fitSource: 'measured', disagrees: false });
  });
});

describe('rankByIntent staleness', () => {
  const assessment = (modelId, charsPerSecond, staleness) => ({
    backend: 'ollama',
    modelId,
    verdict: 'fits',
    params: '14B',
    residentGb: 8,
    environment: { memoryBudgetGb: 40 },
    performance: {
      meanCharsPerSecond: charsPerSecond,
      contextDegradation: 0.9,
      maxWorkingContextTokens: 4096,
      samplesRun: 2,
      samplesOk: 2,
    },
    staleness,
  });

  it('never lets a stale reading outrank a fresh one, however good its numbers', () => {
    const { ranked } = rankByIntent([
      assessment('stale-but-fast:14b', 240, { comparable: true, stale: true, changes: [{ field: 'totalMemoryGb', label: 'installed memory', from: 128, to: 32 }] }),
      assessment('fresh-but-slow:14b', 20, { comparable: true, stale: false, changes: [] }),
    ], 'fastest');
    expect(ranked.map((r) => r.modelId)).toEqual(['fresh-but-slow:14b', 'stale-but-fast:14b']);
    // Still listed, though — this panel is where the user re-runs it.
    expect(ranked[1].staleness.stale).toBe(true);
  });

  it('ranks on score alone when nothing is stale', () => {
    const { ranked } = rankByIntent([
      assessment('slow:14b', 20, { comparable: true, stale: false, changes: [] }),
      assessment('fast:14b', 240, { comparable: true, stale: false, changes: [] }),
    ], 'fastest');
    expect(ranked.map((r) => r.modelId)).toEqual(['fast:14b', 'slow:14b']);
  });

  it('treats a record with no staleness annotation as un-demoted', () => {
    // `staleness: null` means the caller never compared — that is not evidence
    // of staleness, so it must not push the entry down the list.
    const { ranked } = rankByIntent([
      assessment('unannotated:14b', 240, undefined),
      assessment('fresh:14b', 20, { comparable: true, stale: false, changes: [] }),
    ], 'fastest');
    expect(ranked[0].modelId).toBe('unannotated:14b');
  });
});

// ---- tokens per second -------------------------------------------------------

const tokenSample = (contextTokens, tokensPerSecond, { estimated = false, promptRate = null } = {}) => ({
  ...okSample(contextTokens, 200),
  tokensPerSecond,
  promptTokensPerSecond: promptRate,
  completionTokens: 96,
  tokensEstimated: estimated,
});

describe('summarizePerformance — token throughput', () => {
  it('averages the measured tokens/s alongside chars/s', () => {
    const perf = summarizePerformance([tokenSample(512, 40), tokenSample(4096, 20)]);
    expect(perf.meanTokensPerSecond).toBe(30);
    expect(perf.peakTokensPerSecond).toBe(40);
    expect(perf.tokensEstimated).toBe(false);
  });

  // A runtime that reports no usage block must not have a tokens/s figure
  // invented from its character count.
  it('reports null token rates when no sample carried one', () => {
    const perf = summarizePerformance([okSample(512, 200), okSample(4096, 100)]);
    expect(perf.meanTokensPerSecond).toBeNull();
    expect(perf.peakTokensPerSecond).toBeNull();
    expect(perf.tokensEstimated).toBeNull();
    expect(perf.meanCharsPerSecond).toBe(150);
  });

  it('marks the mean as estimated when ANY contributing sample was frame-counted', () => {
    const perf = summarizePerformance([tokenSample(512, 40), tokenSample(4096, 20, { estimated: true })]);
    expect(perf.tokensEstimated).toBe(true);
  });
});

describe('explainAssessment — throughput clause', () => {
  it('leads with tokens/s when it was measured', () => {
    const text = explainAssessment({ performance: summarizePerformance([tokenSample(512, 40)]) }, 'fastest');
    expect(text).toContain('40 tok/s');
    expect(text).not.toContain('chars/s');
  });

  it('falls back to chars/s, and never reports both', () => {
    const text = explainAssessment({ performance: summarizePerformance([okSample(512, 200)]) }, 'fastest');
    expect(text).toContain('200 chars/s');
    expect(text).not.toContain('tok/s');
  });
});

describe('buildThroughputReport', () => {
  const record = (modelId, rates) => ({
    backend: 'ollama',
    modelId,
    tuningKey: '',
    verdict: 'fits',
    samples: rates.map(([context, rate]) => tokenSample(context, rate)),
    performance: summarizePerformance(rates.map(([context, rate]) => tokenSample(context, rate))),
  });

  it('sorts fastest first and collects every sampled context as a column', () => {
    const report = buildThroughputReport([
      record('slow-model', [[512, 10], [4096, 8]]),
      record('fast-model', [[512, 60], [4096, 40]]),
    ]);
    expect(report.rows.map((r) => r.modelId)).toEqual(['fast-model', 'slow-model']);
    expect(report.contexts).toEqual([512, 4096]);
    expect(report.rows[0].points.map((p) => p.tokensPerSecond)).toEqual([60, 40]);
    expect(report.rows[0].points.map((p) => p.totalMs)).toEqual([1000, 1000]);
    expect(report.modelsWithTokenRates).toBe(2);
  });

  // Unmeasured is not slow. A runtime that reports no token counts still gets a
  // row — dropping it would make the table look complete when it isn't.
  it('keeps a row with no token rate, and sorts it last rather than as zero', () => {
    const quiet = {
      backend: 'llama',
      modelId: 'quiet-model',
      verdict: 'fits',
      samples: [okSample(512, 300)],
      performance: summarizePerformance([okSample(512, 300)]),
    };
    const report = buildThroughputReport([quiet, record('fast-model', [[512, 5]])]);
    expect(report.rows.map((r) => r.modelId)).toEqual(['fast-model', 'quiet-model']);
    expect(report.rows[1].meanTokensPerSecond).toBeNull();
    expect(report.rows[1].meanCharsPerSecond).toBe(300);
    expect(report.modelsWithTokenRates).toBe(1);
  });

  it('carries a failed sample as failed rather than dropping the context', () => {
    const report = buildThroughputReport([{
      backend: 'ollama',
      modelId: 'big-model',
      verdict: 'fits',
      samples: [tokenSample(512, 12), failSample(16384, 'out of memory')],
      performance: summarizePerformance([tokenSample(512, 12), failSample(16384, 'out of memory')]),
    }]);
    expect(report.contexts).toEqual([512, 16384]);
    const failed = report.rows[0].points.find((p) => p.contextTokens === 16384);
    expect(failed.ok).toBe(false);
    expect(failed.tokensPerSecond).toBeNull();
    expect(failed.error).toBe('out of memory');
  });

  it('returns an empty report for no assessments rather than throwing', () => {
    expect(buildThroughputReport(null)).toEqual({ rows: [], contexts: [], modelsWithTokenRates: 0 });
  });
});

// ---- sweep target selection --------------------------------------------------

describe('selectSweepTargets', () => {
  const stale = {
    backend: 'ollama', modelId: 'stale-model', tuningKey: 'ctx=8192', tuningLabel: '8k context',
    tuning: { numCtx: 8192 }, staleness: { stale: true },
  };
  const fresh = {
    backend: 'ollama', modelId: 'fresh-model', tuningKey: '', tuningLabel: null,
    tuning: {}, staleness: { stale: false },
  };
  const unassessed = [{ backend: 'lmstudio', modelId: 'new-model' }];

  it('queues only never-measured models for the unmeasured scope', () => {
    const targets = selectSweepTargets({ assessments: [stale, fresh], unassessed, scope: 'unmeasured' });
    expect(targets.map((t) => t.modelId)).toEqual(['new-model']);
  });

  it('queues only stale readings for the stale scope', () => {
    const targets = selectSweepTargets({ assessments: [stale, fresh], unassessed, scope: 'stale' });
    expect(targets.map((t) => t.modelId)).toEqual(['stale-model']);
  });

  // A re-measure has to reproduce the configuration that produced the record, or
  // the sweep quietly replaces every tuned reading with a defaults one.
  it('re-uses each record\'s tuning so a re-measure reproduces its configuration', () => {
    const [target] = selectSweepTargets({ assessments: [stale], unassessed: [], scope: 'stale' });
    expect(target.tuning).toEqual({ numCtx: 8192 });
    expect(target.tuningKey).toBe('ctx=8192');
  });

  it('covers unmeasured models FIRST in the all scope, so a cut-short run got the unknowns', () => {
    const targets = selectSweepTargets({ assessments: [stale, fresh], unassessed, scope: 'all' });
    expect(targets.map((t) => t.modelId)).toEqual(['new-model', 'stale-model', 'fresh-model']);
  });

  it('never queues the same model+tuning twice', () => {
    const targets = selectSweepTargets({
      assessments: [fresh, fresh],
      unassessed: [{ backend: 'ollama', modelId: 'fresh-model' }],
      scope: 'all',
    });
    expect(targets).toHaveLength(1);
  });

  it('falls back to the unmeasured scope for an unrecognized scope', () => {
    const targets = selectSweepTargets({ assessments: [stale], unassessed, scope: 'everything-please' });
    expect(targets.map((t) => t.modelId)).toEqual(['new-model']);
  });

  // ---- the second dimension ------------------------------------------------
  // `tunings` is what makes a TUNING sweep a case of this selector rather than a
  // queue of its own: same dedupe, same ordering, same consent-count guarantee.
  const grid = [
    { tuning: {}, key: '', label: null },
    { tuning: { flashAttn: true }, key: 'flashAttn=true', label: 'Flash attention on' },
  ];

  it('restricts the queue to the named model, whatever the scope would have picked', () => {
    const targets = selectSweepTargets({
      assessments: [stale, fresh], unassessed, scope: 'unmeasured',
      only: { backend: 'ollama', modelId: 'fresh-model' },
    });
    expect(targets.map((t) => t.modelId)).toEqual(['fresh-model']);
  });

  it('returns nothing for a model no record or listing names', () => {
    const targets = selectSweepTargets({
      assessments: [stale], unassessed, scope: 'all',
      only: { backend: 'ollama', modelId: 'ghost' },
    });
    expect(targets).toEqual([]);
  });

  it('crosses every selected model with the grid, one measurement per pair', () => {
    const targets = selectSweepTargets({ assessments: [], unassessed, scope: 'unmeasured', tunings: grid });
    expect(targets.map((t) => `${t.modelId}@${t.tuningKey}`))
      .toEqual(['new-model@', 'new-model@flashAttn=true']);
  });

  // The grid REPLACES each record's own tuning — that is the whole point of the
  // dimension. Keeping the stored tuning would measure the same configuration
  // under every variant's label.
  it('replaces a record\'s stored tuning with the grid variant', () => {
    const [baseline, variant] = selectSweepTargets({
      assessments: [stale], unassessed: [], scope: 'stale', tunings: grid,
    });
    expect(baseline.tuning).toEqual({});
    expect(baseline.tuningLabel).toBeNull();
    expect(variant.tuning).toEqual({ flashAttn: true });
    expect(variant.tuningLabel).toBe('Flash attention on');
  });

  // A model that reached the cross under two stored tunings is still ONE model:
  // measuring each variant twice would put the same configuration on both sides
  // of the comparison table.
  it('crosses a model held under several stored tunings only once', () => {
    const other = { ...stale, tuningKey: 'ctx=4096', tuning: { numCtx: 4096 } };
    const targets = selectSweepTargets({
      assessments: [stale, other], unassessed: [], scope: 'stale', tunings: grid,
    });
    expect(targets).toHaveLength(2);
  });

  it('leaves the queue alone for an empty grid rather than emptying it', () => {
    const targets = selectSweepTargets({ assessments: [], unassessed, scope: 'unmeasured', tunings: [] });
    expect(targets.map((t) => t.modelId)).toEqual(['new-model']);
  });
});

describe('summarizeSweepScopes', () => {
  it('counts exactly what each scope would run', () => {
    const counts = summarizeSweepScopes({
      assessments: [{ backend: 'ollama', modelId: 'a', staleness: { stale: true } }],
      unassessed: [{ backend: 'ollama', modelId: 'b' }, { backend: 'ollama', modelId: 'c' }],
    });
    expect(counts).toEqual({ unmeasured: 2, stale: 1, all: 3 });
  });
});
