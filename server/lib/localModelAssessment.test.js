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
      { backend: 'ollama', modelId: 'example-model:70b', verdict: 'does-not-fit', reason: 'out of memory' },
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

  it('is empty and safe on no input', () => {
    expect(rankByIntent(undefined, 'balanced')).toEqual({ intent: 'balanced', ranked: [], excluded: [] });
  });

  it('falls back to the balanced intent for an unknown one', () => {
    expect(rankByIntent([], 'nonsense').intent).toBe('balanced');
  });
});
