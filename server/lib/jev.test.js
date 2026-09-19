import { describe, expect, it } from 'vitest';
import {
  JEV_DEFAULT_MIN_MARGIN,
  JEV_FAILURE_CODES,
  JEV_SIDECAR_FAILURE_CODES,
  JEV_MAX_HYPOTHESES,
  JEV_MAX_HYPOTHESIS_CHARS,
  JEV_MAX_PREMISE_CHARS,
  JEV_MODEL,
  JEV_REQUIRED_FILES,
  JEV_STAGES,
  JEV_SUBFOLDER,
  decideFromScores,
  jevScoreRequestSchema,
  jevStageReadiness,
  normalizeJevScores,
} from './jev.js';

const score = (hypothesis, entailment, rest = {}) => ({
  hypothesis,
  entailment,
  contradiction: 0,
  neutral: 0,
  ...rest,
});

describe('pinned jev contract', () => {
  // The repository is an aggregate carrying a 35B MoE variant, trained MLP
  // heads, and a `code/` directory. A file escaping the pinned subfolder would
  // be downloaded — and in the `code/` case, would be repository Python.
  it('confines every required file to the pinned 4B subfolder', () => {
    expect(JEV_REQUIRED_FILES.length).toBeGreaterThan(0);
    for (const file of JEV_REQUIRED_FILES) {
      expect(file.startsWith(`${JEV_SUBFOLDER}/`)).toBe(true);
      expect(file).not.toContain('..');
    }
    expect(JEV_REQUIRED_FILES.some((file) => file.includes('mlp_heads'))).toBe(false);
    expect(JEV_REQUIRED_FILES.some((file) => file.startsWith('code/'))).toBe(false);
  });

  it('pins an exact revision and declares the model ungated', () => {
    expect(JEV_MODEL.revision).toMatch(/^[a-f0-9]{40}$/);
    // Ungated is why JEV_STAGES has four entries and no token step; if the
    // model ever became gated, both would have to change together.
    expect(JEV_MODEL.gated).toBe(false);
    expect(JEV_STAGES.map((stage) => stage.id)).toEqual(['python', 'venv', 'packages', 'model']);
  });
});

describe('failure codes', () => {
  // A code the sidecar may put in an error body is forwarded verbatim; one it
  // may not is collapsed. Widening the sidecar subset to the full list would
  // let a reply send an operator to reinstall a working install.
  it('keeps the sidecar-reportable subset narrower than the full vocabulary', () => {
    expect(JEV_SIDECAR_FAILURE_CODES.every((code) => JEV_FAILURE_CODES.includes(code))).toBe(true);
    for (const code of ['jev-not-installed', 'jev-start-failed', 'jev-timeout']) {
      expect(JEV_SIDECAR_FAILURE_CODES).not.toContain(code);
    }
  });
});

describe('jevStageReadiness', () => {
  // `ready` is the scoring-time gate. Cleared prerequisites do not make the
  // scorer usable, and a status that said otherwise would let a caller reach a
  // sidecar that cannot load.
  it('is ready only when the packages import AND the snapshot is cached', () => {
    const prerequisites = { pythonAvailable: true, venvReady: true };
    expect(jevStageReadiness({ ...prerequisites }).ready).toBe(false);
    expect(jevStageReadiness({ ...prerequisites, runtimeReady: true }).ready).toBe(false);
    expect(jevStageReadiness({ ...prerequisites, modelCached: true }).ready).toBe(false);
    expect(jevStageReadiness({ ...prerequisites, runtimeReady: true, modelCached: true }).ready).toBe(true);
  });

  it('reports every declared stage, with no invented entries', () => {
    const { stages } = jevStageReadiness({ pythonAvailable: true });
    expect(stages.map((stage) => stage.id)).toEqual(JEV_STAGES.map((stage) => stage.id));
    expect(stages.find((stage) => stage.id === 'python').ready).toBe(true);
    expect(stages.find((stage) => stage.id === 'model').ready).toBe(false);
  });
});

describe('jevScoreRequestSchema', () => {
  it('refuses input past each declared bound rather than clamping it', () => {
    const valid = { premise: 'a', hypotheses: ['x', 'y'] };
    expect(jevScoreRequestSchema.safeParse(valid).success).toBe(true);
    expect(jevScoreRequestSchema.safeParse({ ...valid, premise: 'a'.repeat(JEV_MAX_PREMISE_CHARS + 1) }).success).toBe(false);
    expect(jevScoreRequestSchema.safeParse({ ...valid, hypotheses: Array.from({ length: JEV_MAX_HYPOTHESES + 1 }, (_, i) => `h${i}`) }).success).toBe(false);
    expect(jevScoreRequestSchema.safeParse({ ...valid, hypotheses: ['a'.repeat(JEV_MAX_HYPOTHESIS_CHARS + 1)] }).success).toBe(false);
    // Strict: an unrecognized key is a caller reaching for a parameter that
    // does not exist, not something to silently drop.
    expect(jevScoreRequestSchema.safeParse({ ...valid, modelDir: '/etc' }).success).toBe(false);
  });
});

describe('normalizeJevScores', () => {
  const wire = (scores) => ({ schemaVersion: 1, complete: true, scores });

  it('accepts a reply that matches the asked hypotheses in order', () => {
    const scores = [score('a', 0.8), score('b', 0.1)];
    expect(normalizeJevScores(wire(scores), { hypotheses: ['a', 'b'] })).toEqual({ ok: true, scores });
  });

  // The failure this uniquely catches: a well-formed reply describing a
  // DIFFERENT hypothesis list silently re-labels every score, so the decision
  // is confidently about options nobody asked about.
  it('rejects a well-formed reply whose hypotheses are reordered or substituted', () => {
    expect(normalizeJevScores(wire([score('b', 0.8), score('a', 0.1)]), { hypotheses: ['a', 'b'] }))
      .toEqual({ ok: false, code: 'jev-response-invalid' });
    expect(normalizeJevScores(wire([score('a', 0.8), score('c', 0.1)]), { hypotheses: ['a', 'b'] }))
      .toEqual({ ok: false, code: 'jev-response-invalid' });
    expect(normalizeJevScores(wire([score('a', 0.8)]), { hypotheses: ['a', 'b'] }))
      .toEqual({ ok: false, code: 'jev-response-invalid' });
  });

  it('rejects a malformed or out-of-range wire payload', () => {
    expect(normalizeJevScores(null, { hypotheses: ['a'] }).code).toBe('jev-response-invalid');
    expect(normalizeJevScores(wire([score('a', 1.4)]), { hypotheses: ['a'] }).code).toBe('jev-response-invalid');
    expect(normalizeJevScores({ ...wire([score('a', 0.9)]), complete: false }, { hypotheses: ['a'] }).code).toBe('jev-response-invalid');
  });
});

describe('decideFromScores', () => {
  // The load-bearing behavior of the whole service: a near-tie must ABSTAIN,
  // not pick. A regression here is silent — every caller still gets a choice.
  it('abstains on a near-tie rather than picking the nominal winner', () => {
    const result = decideFromScores([score('reply', 0.52), score('none', 0.49)]);
    expect(result).toMatchObject({ ok: true, abstained: true, choice: null, confidence: null });
    expect(result.margin).toBeCloseTo(0.03, 5);
  });

  it('picks when the margin clears the threshold, reporting the raw confidence', () => {
    const result = decideFromScores([score('none', 0.12), score('reply', 0.88)]);
    expect(result).toMatchObject({ ok: true, abstained: false, choice: 'reply' });
    expect(result.confidence).toBeCloseTo(0.88, 5);
    expect(result.margin).toBeCloseTo(0.76, 5);
  });

  // Confidence is reported but NOT gated on — documented in lib/jev.js and the
  // ADR, so a caller that wants a floor knows it has to apply one itself.
  it('picks a clear but weak winner, leaving any confidence floor to the caller', () => {
    expect(decideFromScores([score('a', 0.2), score('b', 0.02)])).toMatchObject({ abstained: false, choice: 'a' });
  });

  it('honours an explicit threshold on either side of the default', () => {
    const near = [score('a', 0.52), score('b', 0.49)];
    expect(decideFromScores(near, 0.01).abstained).toBe(false);
    expect(decideFromScores([score('a', 0.88), score('b', 0.12)], 0.9).abstained).toBe(true);
    // A non-numeric threshold falls back to the shipped default rather than
    // producing NaN comparisons, which would never abstain.
    expect(decideFromScores(near, undefined).abstained).toBe(true);
    expect(JEV_DEFAULT_MIN_MARGIN).toBeGreaterThan(0.03);
  });

  it('refuses a single option instead of inventing a runner-up', () => {
    expect(decideFromScores([score('a', 0.99)])).toEqual({ ok: false, code: 'jev-request-invalid' });
    expect(decideFromScores([])).toEqual({ ok: false, code: 'jev-request-invalid' });
  });

  it('does not reorder the caller\'s request-ordered score array', () => {
    const scores = [score('a', 0.1), score('b', 0.9)];
    decideFromScores(scores);
    expect(scores.map((entry) => entry.hypothesis)).toEqual(['a', 'b']);
  });
});
