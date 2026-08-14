import { describe, it, expect } from 'vitest';
import {
  computeReviewVerdict,
  collectReviewFindings,
  shapeFeedbackFinding,
  buildFeedbackRoutePrompt,
  manuscriptInputs,
  seriesReviewInputsHash,
  isSeriesReviewSourceStale,
  isSeriesReviewFindingsStale,
} from './seriesReview.js';

describe('computeReviewVerdict', () => {
  it("is 'ready' when health is clean, foundation clears the threshold, and canon is ready", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 8.2 },
      canon: { ready: true },
      threshold: 7.5,
    })).toBe('ready');
  });

  it("is 'issues' when the health gate is not clean", () => {
    expect(computeReviewVerdict({
      health: { ready: false },
      foundation: { weightedScore: 9 },
      canon: { ready: true },
    })).toBe('issues');
  });

  it("is 'issues' when the foundation is below the threshold", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 6 },
      canon: { ready: true },
      threshold: 7.5,
    })).toBe('issues');
  });

  it("is 'issues' when canon is not ready", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 9 },
      canon: { ready: false },
    })).toBe('issues');
  });

  it('treats a missing foundation / canon as non-blocking (absent, not failing)', () => {
    expect(computeReviewVerdict({ health: { ready: true }, foundation: null, canon: null })).toBe('ready');
  });

  it('treats a non-finite foundation score as non-blocking', () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: NaN },
      canon: { ready: true },
    })).toBe('ready');
  });

  it("is 'issues' when the review is incomplete (a stage errored / never ran — must not read ready)", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 9 },
      canon: { ready: true },
      incomplete: true,
    })).toBe('issues');
  });

  it("is 'ready' when complete and all dimensions pass (incomplete false)", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 9 },
      canon: { ready: true },
      incomplete: false,
    })).toBe('ready');
  });
});

describe('collectReviewFindings', () => {
  const comments = [
    { id: 'a', severity: 'low', status: 'open', issueNumber: 2, problem: 'nit', checkId: 'style' },
    { id: 'b', severity: 'high', status: 'open', issueNumber: 3, problem: 'big', checkId: 'continuity', anchorQuote: 'q', location: 'V1' },
    { id: 'c', severity: 'high', status: 'open', issueNumber: 1, problem: 'also big' },
    { id: 'd', severity: 'medium', status: 'accepted', issueNumber: 1, problem: 'fixed already' },
    { id: 'e', severity: 'medium', status: 'dismissed', issueNumber: 1, problem: 'waived' },
  ];

  it('keeps only OPEN findings (drops accepted + dismissed)', () => {
    const out = collectReviewFindings(comments);
    expect(out.map((f) => f.commentId)).not.toContain('d');
    expect(out.map((f) => f.commentId)).not.toContain('e');
    expect(out).toHaveLength(3);
  });

  it('sorts high→low severity, then by issue number', () => {
    const out = collectReviewFindings(comments);
    // Both highs first (issue 1 before 3), then the low.
    expect(out.map((f) => f.commentId)).toEqual(['c', 'b', 'a']);
  });

  it('surfaces the commentId + anchoring fields the fix path needs', () => {
    const out = collectReviewFindings(comments);
    const b = out.find((f) => f.commentId === 'b');
    expect(b).toMatchObject({ severity: 'high', issueNumber: 3, anchorQuote: 'q', location: 'V1', summary: 'big', checkId: 'continuity' });
  });

  it('tolerates a non-array input', () => {
    expect(collectReviewFindings(null)).toEqual([]);
  });
});

describe('shapeFeedbackFinding', () => {
  const validNumbers = new Set([1, 2, 3]);

  it('adopts a valid routed issue number + severity', () => {
    const f = shapeFeedbackFinding(
      { issueNumber: 2, severity: 'high', problem: 'pacing drags', suggestion: 'cut', location: 'V2', anchorQuote: 'the quiet' },
      { feedback: 'raw', validNumbers },
    );
    expect(f).toMatchObject({
      issueNumber: 2, severity: 'high', problem: 'pacing drags', suggestion: 'cut', location: 'V2', anchorQuote: 'the quiet',
      checkId: 'user-feedback', category: 'user-feedback',
    });
  });

  it('degrades a hallucinated issue number to a series-level (null) finding', () => {
    const f = shapeFeedbackFinding({ issueNumber: 99, problem: 'x' }, { feedback: 'raw', validNumbers });
    expect(f.issueNumber).toBeNull();
  });

  it('falls back to the raw feedback as the problem when the model omits it', () => {
    const f = shapeFeedbackFinding({}, { feedback: 'volume 1 has no real development', validNumbers });
    expect(f.problem).toBe('volume 1 has no real development');
    expect(f.severity).toBe('medium');
    expect(f.issueNumber).toBeNull();
  });

  it('defaults an invalid severity to medium', () => {
    const f = shapeFeedbackFinding({ severity: 'critical', problem: 'x' }, { feedback: 'raw', validNumbers });
    expect(f.severity).toBe('medium');
  });

  it('accepts an array of valid numbers (not only a Set)', () => {
    const f = shapeFeedbackFinding({ issueNumber: 3, problem: 'x' }, { feedback: 'raw', validNumbers: [1, 2, 3] });
    expect(f.issueNumber).toBe(3);
  });
});

describe('buildFeedbackRoutePrompt', () => {
  it('lists the issue roster and embeds the feedback', () => {
    const prompt = buildFeedbackRoutePrompt('check the pacing', [
      { number: 1, title: 'Origins' },
      { number: 2, title: 'Fallout' },
    ]);
    expect(prompt).toContain('#1: Origins');
    expect(prompt).toContain('#2: Fallout');
    expect(prompt).toContain('check the pacing');
    expect(prompt).toContain('issueNumber');
  });

  it('handles an empty roster', () => {
    const prompt = buildFeedbackRoutePrompt('note', []);
    expect(prompt).toContain('(no issues yet)');
  });
});

describe('manuscriptInputs', () => {
  const issue = (over = {}) => ({ id: 'iss-1', number: 1, stages: { prose: { output: 'the draft' } }, ...over });

  it('flips the projection when a drafted stage OUTPUT changes', () => {
    const before = manuscriptInputs([issue()]);
    const after = manuscriptInputs([issue({ stages: { prose: { output: 'a rewritten draft' } } })]);
    expect(after).not.toEqual(before);
  });

  it('flips the projection when a stage INPUT (the seed) changes, not only the output', () => {
    const before = manuscriptInputs([issue({ stages: { prose: { input: 'beats', output: 'the draft' } } })]);
    const after = manuscriptInputs([issue({ stages: { prose: { input: 'new beats', output: 'the draft' } } })]);
    expect(after).not.toEqual(before);
  });

  it('covers every manuscript stage, not just the highest-precedence one', () => {
    const base = { id: 'iss-1', stages: { comicScript: { output: 'PAGE 1' }, prose: { output: 'the draft' } } };
    const edited = { id: 'iss-1', stages: { comicScript: { output: 'PAGE 1' }, prose: { output: 'edited prose' } } };
    // `comicScript` outranks `prose` in the stitched corpus, so a prose-only edit
    // is exactly the drift a precedence-picking projection would miss.
    expect(manuscriptInputs([edited])).not.toEqual(manuscriptInputs([base]));
  });

  it('is stable across a listing re-order (a re-order is not an edit)', () => {
    const a = issue();
    const b = issue({ id: 'iss-2', number: 2 });
    expect(manuscriptInputs([a, b])).toEqual(manuscriptInputs([b, a]));
  });

  it('tolerates a non-array input and issues with no stages', () => {
    expect(manuscriptInputs(null)).toEqual([]);
    expect(manuscriptInputs([{}])).toHaveLength(1);
  });
});

describe('seriesReviewInputsHash', () => {
  const series = { id: 'ser-1', targetFormat: 'comic+tv', severityWeights: null };
  const universe = {
    id: 'uni-1',
    logline: 'A quiet town keeps a loud secret.',
    characters: [{ id: 'ch-1', name: 'Ada', description: 'a tall figure in a long coat' }],
    places: [],
    objects: [],
  };
  const issues = [{ id: 'iss-1', number: 1, stages: { prose: { output: 'the draft' } } }];
  const base = () => seriesReviewInputsHash({ series, universe, issues });

  it('is deterministic for unchanged inputs', () => {
    expect(base()).toBe(seriesReviewInputsHash({ series, universe, issues }));
  });

  it('changes when the manuscript is edited', () => {
    const edited = [{ id: 'iss-1', number: 1, stages: { prose: { output: 'a rewritten draft' } } }];
    expect(seriesReviewInputsHash({ series, universe, issues: edited })).not.toBe(base());
  });

  it('changes when a canon DESCRIPTION is edited (a field the foundation projection does not carry)', () => {
    const edited = { ...universe, characters: [{ id: 'ch-1', name: 'Ada', description: 'a short figure in a raincoat' }] };
    expect(seriesReviewInputsHash({ series, universe: edited, issues })).not.toBe(base());
  });

  it('changes when a foundation input (the world logline) is edited', () => {
    const edited = { ...universe, logline: 'A loud town keeps a quiet secret.' };
    expect(seriesReviewInputsHash({ series, universe: edited, issues })).not.toBe(base());
  });

  it('changes when the health severity weights change (same sources, different scoring)', () => {
    const edited = { ...series, severityWeights: { high: 20, medium: 5, low: 1 } };
    expect(seriesReviewInputsHash({ series: edited, universe, issues })).not.toBe(base());
  });

  it('changes when the target format changes (it selects the canon source text)', () => {
    expect(seriesReviewInputsHash({ series: { ...series, targetFormat: 'tv' }, universe, issues })).not.toBe(base());
  });

  it('is unchanged by key ordering (a synced/imported record may re-order keys)', () => {
    const reordered = { objects: [], places: [], characters: universe.characters, logline: universe.logline, id: 'uni-1' };
    expect(seriesReviewInputsHash({ series, universe: reordered, issues })).toBe(base());
  });

  it('tolerates a series with no linked universe', () => {
    expect(typeof seriesReviewInputsHash({ series, universe: null, issues })).toBe('string');
  });
});

describe('isSeriesReviewSourceStale', () => {
  it('flags a snapshot whose pinned hash no longer matches the current sources', () => {
    expect(isSeriesReviewSourceStale({ sourceInputsHash: 'aaa' }, 'bbb')).toBe(true);
  });

  it('does not flag a snapshot whose sources are unchanged', () => {
    expect(isSeriesReviewSourceStale({ sourceInputsHash: 'aaa' }, 'aaa')).toBe(false);
  });

  it('never flags a pre-#4111 snapshot that carries no hash (it cannot be judged)', () => {
    expect(isSeriesReviewSourceStale({ verdict: 'ready' }, 'aaa')).toBe(false);
    expect(isSeriesReviewSourceStale(null, 'aaa')).toBe(false);
  });

  it('flags a hashed snapshot whose current hash could not be recomputed (fails closed)', () => {
    expect(isSeriesReviewSourceStale({ sourceInputsHash: 'aaa' }, null)).toBe(true);
  });
});

describe('isSeriesReviewFindingsStale', () => {
  it('is false when the live open set matches the pinned ids', () => {
    expect(isSeriesReviewFindingsStale({ findingIds: ['a', 'b'] }, new Set(['a', 'b']))).toBe(false);
  });

  it('is true when a pinned finding was accepted/dismissed', () => {
    expect(isSeriesReviewFindingsStale({ findingIds: ['a', 'b'] }, new Set(['a']))).toBe(true);
  });

  it('is true when a new finding appeared', () => {
    expect(isSeriesReviewFindingsStale({ findingIds: ['a'] }, new Set(['a', 'b']))).toBe(true);
  });

  it('falls back to the embedded findings for a snapshot with no findingIds', () => {
    expect(isSeriesReviewFindingsStale({ findings: [{ commentId: 'a' }] }, new Set(['a']))).toBe(false);
    expect(isSeriesReviewFindingsStale({ findings: [{ commentId: 'a' }] }, new Set())).toBe(true);
  });

  it('accepts an array of live ids (not only a Set)', () => {
    expect(isSeriesReviewFindingsStale({ findingIds: ['a'] }, ['a'])).toBe(false);
  });
});
