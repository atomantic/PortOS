import { describe, it, expect } from 'vitest';
import {
  mergeObjectLWW,
  mergeDeepUnion,
  unionByKey,
  mergeTaste,
  mergeMeta,
  mergeConfidence,
  mergeSocialAccounts,
  mergeAutobiographyStories,
  mergeTasteObserved,
  safeMdName,
} from './digital-twin-sync.js';

describe('mergeObjectLWW', () => {
  it('takes remote when local is missing', () => {
    expect(mergeObjectLWW(null, { updatedAt: '2026-01-01' })).toEqual({
      merged: { updatedAt: '2026-01-01' },
      changed: true,
    });
  });
  it('keeps local when remote is missing/invalid', () => {
    expect(mergeObjectLWW({ updatedAt: '2026-01-01' }, null).changed).toBe(false);
  });
  it('remote wins only when strictly newer', () => {
    const local = { v: 'L', updatedAt: '2026-01-02' };
    expect(mergeObjectLWW(local, { v: 'R', updatedAt: '2026-01-01' }).merged.v).toBe('L');
    expect(mergeObjectLWW(local, { v: 'R', updatedAt: '2026-01-03' }).merged.v).toBe('R');
    expect(mergeObjectLWW(local, { v: 'R', updatedAt: '2026-01-02' }).changed).toBe(false);
  });
  it('federates observed evidence (#2156) LWW on derivedAt — newest observation wins', () => {
    // taste-observed.json / chronotype-observed.json are regenerated derived
    // records, so the sync merges them wholesale on the derivedAt stamp.
    const local = { source: 'observed', derivedAt: '2026-07-01T00:00:00Z', observedType: 'morning' };
    const remote = { source: 'observed', derivedAt: '2026-07-05T00:00:00Z', observedType: 'evening' };
    expect(mergeObjectLWW(local, remote, 'derivedAt').merged.observedType).toBe('evening');
    expect(mergeObjectLWW(remote, local, 'derivedAt').merged.observedType).toBe('evening');
    // A peer that sends no observed evidence can't blank the local record.
    expect(mergeObjectLWW(local, null, 'derivedAt')).toEqual({ merged: local, changed: false });
  });
});

describe('mergeTasteObserved (#2156 — preserve user AI interpretation across LWW)', () => {
  const body = (derivedAt, extra = {}) => ({ source: 'observed', derivedAt, ...extra });
  const interp = (generatedAt, text = 'x') => ({ text, generatedAt });

  it('LWW on derivedAt for the rollup body', () => {
    const local = body('2026-07-01T00:00:00Z', { total: 1 });
    const remote = body('2026-07-05T00:00:00Z', { total: 9 });
    expect(mergeTasteObserved(local, remote).merged.total).toBe(9);
  });

  it('keeps the local interpretation when a newer remote recompute carries none', () => {
    // The exact drop bug: peer recompute wins the body but must NOT lose the
    // user's interpretation.
    const local = body('2026-07-01T00:00:00Z', { interpretation: interp('2026-07-02T00:00:00Z', 'mine') });
    const remote = body('2026-07-05T00:00:00Z'); // newer body, no interpretation
    const { merged, changed } = mergeTasteObserved(local, remote);
    expect(merged.derivedAt).toBe('2026-07-05T00:00:00Z'); // remote body won
    expect(merged.interpretation.text).toBe('mine');       // interpretation survived
    expect(changed).toBe(true);
  });

  it('takes the newer interpretation regardless of which body won', () => {
    const local = body('2026-07-05T00:00:00Z', { interpretation: interp('2026-07-01T00:00:00Z', 'old') });
    const remote = body('2026-07-01T00:00:00Z', { interpretation: interp('2026-07-06T00:00:00Z', 'new') });
    const merged = mergeTasteObserved(local, remote).merged;
    expect(merged.derivedAt).toBe('2026-07-05T00:00:00Z'); // local body won (newer)
    expect(merged.interpretation.text).toBe('new');        // remote interpretation is newer
  });

  it('is a no-op when neither side has an interpretation and the body is unchanged', () => {
    const local = body('2026-07-05T00:00:00Z');
    const remote = body('2026-07-01T00:00:00Z');
    expect(mergeTasteObserved(local, remote).changed).toBe(false);
  });
});

describe('mergeDeepUnion', () => {
  it('unions nested marker objects, local wins per-key', () => {
    const local = { markers: { a: 1 }, derivedAt: '2026-01-01' };
    const remote = { markers: { a: 9, b: 2 }, derivedAt: '2026-01-02' };
    const { merged, changed } = mergeDeepUnion(local, remote, 'derivedAt');
    expect(merged.markers).toEqual({ a: 1, b: 2 });
    expect(merged.derivedAt).toBe('2026-01-02');
    expect(changed).toBe(true);
  });
  it('fills locally-missing/default scalars from remote', () => {
    const { merged } = mergeDeepUnion({ score: 0, derivedAt: '' }, { score: 5, age: 40, derivedAt: '' }, 'derivedAt');
    expect(merged.score).toBe(5);
    expect(merged.age).toBe(40);
  });
});

describe('unionByKey', () => {
  it('adds remote records not present locally; keeps local on conflict (add-only)', () => {
    const { merged, changed } = unionByKey(
      [{ id: 'a', v: 'L' }],
      [{ id: 'a', v: 'R' }, { id: 'b', v: 'R' }],
      'id'
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((x) => x.id === 'a').v).toBe('L');
    expect(changed).toBe(true);
  });
  it('LWW on conflict when a timestampField is provided', () => {
    const { merged } = unionByKey(
      [{ id: 'a', v: 'L', updatedAt: '2026-01-01' }],
      [{ id: 'a', v: 'R', updatedAt: '2026-01-09' }],
      'id',
      'updatedAt'
    );
    expect(merged[0].v).toBe('R');
  });
  it('tolerates non-array inputs', () => {
    expect(unionByKey(null, undefined, 'id')).toEqual({ merged: [], changed: false });
  });
});

describe('mergeTaste', () => {
  it('unions responses across machines so no answer is lost', () => {
    const local = {
      updatedAt: '2026-03-01',
      sections: { movies: { status: 'in_progress', responses: [{ questionId: 'movies-core-1', answer: 'A', answeredAt: '2026-02-01' }], summary: null } },
    };
    const remote = {
      updatedAt: '2026-03-02',
      sections: { movies: { status: 'in_progress', responses: [{ questionId: 'movies-core-2', answer: 'B', answeredAt: '2026-02-02' }], summary: null } },
    };
    const { merged, changed } = mergeTaste(local, remote);
    const ids = merged.sections.movies.responses.map((r) => r.questionId).sort();
    expect(ids).toEqual(['movies-core-1', 'movies-core-2']);
    expect(changed).toBe(true);
  });

  it('LWW per response by updatedAt||answeredAt', () => {
    const local = { updatedAt: '2026-03-01', sections: { music: { status: 'in_progress', responses: [{ questionId: 'q', answer: 'old', answeredAt: '2026-01-01' }], summary: null } } };
    const remote = { updatedAt: '2026-03-01', sections: { music: { status: 'in_progress', responses: [{ questionId: 'q', answer: 'new', updatedAt: '2026-02-01' }], summary: null } } };
    const { merged } = mergeTaste(local, remote);
    expect(merged.sections.music.responses[0].answer).toBe('new');
  });

  it('adds a whole section the local profile is missing', () => {
    const local = { updatedAt: '2026-03-01', sections: { movies: { status: 'completed', responses: [], summary: 'm' } } };
    const remote = { updatedAt: '2026-03-01', sections: { food: { status: 'in_progress', responses: [{ questionId: 'food-core-1', answer: 'x' }], summary: null } } };
    const { merged, changed } = mergeTaste(local, remote);
    expect(merged.sections.food).toBeDefined();
    expect(merged.sections.movies).toBeDefined();
    expect(changed).toBe(true);
  });

  it('takes the more-complete section status and fills a missing summary', () => {
    const local = { updatedAt: '2026-03-01', sections: { art: { status: 'in_progress', responses: [], summary: null } } };
    const remote = { updatedAt: '2026-03-01', sections: { art: { status: 'completed', responses: [], summary: 'done' } } };
    const { merged } = mergeTaste(local, remote);
    expect(merged.sections.art.status).toBe('completed');
    expect(merged.sections.art.summary).toBe('done');
  });

  it('does not clobber a local summary with remote', () => {
    const local = { updatedAt: '2026-03-01', sections: { art: { status: 'completed', responses: [], summary: 'mine' } } };
    const remote = { updatedAt: '2026-03-09', sections: { art: { status: 'completed', responses: [], summary: 'theirs' } } };
    const { merged } = mergeTaste(local, remote);
    expect(merged.sections.art.summary).toBe('mine');
  });

  it('takes remote profileSummary only when the file is newer', () => {
    const base = { sections: {} };
    expect(mergeTaste({ ...base, updatedAt: '2026-03-09', profileSummary: 'L' }, { ...base, updatedAt: '2026-03-01', profileSummary: 'R' }).merged.profileSummary).toBe('L');
    expect(mergeTaste({ ...base, updatedAt: '2026-03-01', profileSummary: 'L' }, { ...base, updatedAt: '2026-03-09', profileSummary: 'R' }).merged.profileSummary).toBe('R');
  });

  it('takes remote wholesale when local is absent', () => {
    const remote = { updatedAt: '2026-03-01', sections: { movies: { status: 'in_progress', responses: [], summary: null } } };
    expect(mergeTaste(null, remote)).toEqual({ merged: remote, changed: true });
  });

  it('sorts merged responses by questionId (stable on-disk order)', () => {
    const local = { updatedAt: '2026-03-01', sections: { movies: { status: 'in_progress', responses: [{ questionId: 'movies-core-3', answer: 'c' }], summary: null } } };
    const remote = { updatedAt: '2026-03-01', sections: { movies: { status: 'in_progress', responses: [{ questionId: 'movies-core-1', answer: 'a' }, { questionId: 'movies-core-2', answer: 'b' }], summary: null } } };
    const { merged } = mergeTaste(local, remote);
    expect(merged.sections.movies.responses.map((r) => r.questionId)).toEqual(['movies-core-1', 'movies-core-2', 'movies-core-3']);
  });
});

describe('mergeMeta', () => {
  it('unions documents by filename (add-only) and keeps local entry on conflict', () => {
    const local = { documents: [{ id: '1', filename: 'SOUL.md', weight: 9 }] };
    const remote = { documents: [{ id: '1', filename: 'SOUL.md', weight: 1 }, { id: '2', filename: 'FAVORITES.md', weight: 5 }] };
    const { merged, changed } = mergeMeta(local, remote);
    expect(merged.documents).toHaveLength(2);
    expect(merged.documents.find((d) => d.filename === 'SOUL.md').weight).toBe(9);
    expect(changed).toBe(true);
  });

  it('unions all four test histories and personas by id', () => {
    const local = { testHistory: [{ id: 't1' }], personas: [{ id: 'p1' }] };
    const remote = {
      testHistory: [{ id: 't2' }],
      valuesTestHistory: [{ id: 'v1' }],
      adversarialTestHistory: [{ id: 'a1' }],
      multiTurnTestHistory: [{ id: 'm1' }],
      personas: [{ id: 'p2' }],
    };
    const { merged } = mergeMeta(local, remote);
    expect(merged.testHistory.map((x) => x.id).sort()).toEqual(['t1', 't2']);
    expect(merged.valuesTestHistory).toHaveLength(1);
    expect(merged.adversarialTestHistory).toHaveLength(1);
    expect(merged.multiTurnTestHistory).toHaveLength(1);
    expect(merged.personas.map((x) => x.id).sort()).toEqual(['p1', 'p2']);
  });

  it('deep-unions enrichment (categories, max question counts, newest session)', () => {
    const local = { enrichment: { completedCategories: ['core'], lastSession: '2026-01-01', questionsAnswered: { core: 3 } } };
    const remote = { enrichment: { completedCategories: ['social'], lastSession: '2026-02-01', questionsAnswered: { core: 5, social: 2 } } };
    const { merged } = mergeMeta(local, remote);
    expect(merged.enrichment.completedCategories.sort()).toEqual(['core', 'social']);
    expect(merged.enrichment.lastSession).toBe('2026-02-01');
    expect(merged.enrichment.questionsAnswered).toEqual({ core: 5, social: 2 });
  });

  it('fills missing settings keys but keeps local values', () => {
    const local = { settings: { autoInjectToCoS: false } };
    const remote = { settings: { autoInjectToCoS: true, maxContextTokens: 4000 } };
    const { merged } = mergeMeta(local, remote);
    expect(merged.settings).toEqual({ autoInjectToCoS: false, maxContextTokens: 4000 });
  });

  it('takes remote wholesale when local meta is absent', () => {
    const remote = { documents: [{ id: '1', filename: 'SOUL.md' }] };
    expect(mergeMeta(null, remote)).toEqual({ merged: remote, changed: true });
  });
});

describe('mergeAutobiographyStories', () => {
  it('unions stories by id and unions usedPrompts', () => {
    const local = { stories: [{ id: 's1', content: 'L', createdAt: '2026-01-01' }], usedPrompts: ['childhood-0'] };
    const remote = { stories: [{ id: 's2', content: 'R', createdAt: '2026-01-02' }], usedPrompts: ['family-0'] };
    const { merged, changed } = mergeAutobiographyStories(local, remote);
    expect(merged.stories.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    expect(merged.usedPrompts.sort()).toEqual(['childhood-0', 'family-0']);
    expect(changed).toBe(true);
  });

  it('LWW on a shared story by updatedAt||createdAt', () => {
    const local = { stories: [{ id: 's1', content: 'old', createdAt: '2026-01-01' }] };
    const remote = { stories: [{ id: 's1', content: 'new', createdAt: '2026-01-01', updatedAt: '2026-02-01' }] };
    const { merged } = mergeAutobiographyStories(local, remote);
    expect(merged.stories[0].content).toBe('new');
  });

  it('is a no-op when remote has nothing new', () => {
    const local = { stories: [{ id: 's1', createdAt: '2026-01-01' }], usedPrompts: ['a'] };
    expect(mergeAutobiographyStories(local, { stories: [{ id: 's1', createdAt: '2026-01-01' }], usedPrompts: ['a'] }).changed).toBe(false);
  });

  it('sorts merged stories by id (stable on-disk order for checksum convergence)', () => {
    const local = { stories: [{ id: 's3', createdAt: '2026-01-03' }], usedPrompts: ['z'] };
    const remote = { stories: [{ id: 's1', createdAt: '2026-01-01' }, { id: 's2', createdAt: '2026-01-02' }], usedPrompts: ['a'] };
    const { merged } = mergeAutobiographyStories(local, remote);
    expect(merged.stories.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(merged.usedPrompts).toEqual(['a', 'z']);
  });
});

describe('mergeConfidence (analyzed personality traits)', () => {
  it('takes remote when local is missing/invalid', () => {
    const remote = { dimensions: { openness: 0.6 }, overall: 0.6, gaps: [], lastCalculated: '2026-02-01' };
    expect(mergeConfidence(null, remote)).toEqual({ merged: remote, changed: true });
    expect(mergeConfidence(undefined, remote).changed).toBe(true);
  });

  it('keeps local and reports no change when remote is missing/empty', () => {
    const local = { dimensions: { openness: 0.6 }, overall: 0.6, gaps: [], lastCalculated: '2026-02-01' };
    expect(mergeConfidence(local, null).changed).toBe(false);
    expect(mergeConfidence(local, undefined).merged).toBe(local);
  });

  it('maxes each dimension so no machine\'s analysis is lost', () => {
    const local = { dimensions: { openness: 0.8, extraversion: 0.2 }, overall: 0.5, gaps: [], lastCalculated: '2026-01-01' };
    const remote = { dimensions: { openness: 0.4, conscientiousness: 0.9 }, overall: 0.65, gaps: [], lastCalculated: '2026-02-01' };
    const { merged, changed } = mergeConfidence(local, remote);
    expect(merged.dimensions).toEqual({ openness: 0.8, extraversion: 0.2, conscientiousness: 0.9 });
    expect(changed).toBe(true);
  });

  it('recomputes overall as the mean of merged dimensions (2dp)', () => {
    const local = { dimensions: { a: 0.2 }, overall: 0.2, lastCalculated: '2026-01-01' };
    const remote = { dimensions: { a: 0.6, b: 0.9 }, overall: 0.75, lastCalculated: '2026-02-01' };
    const { merged } = mergeConfidence(local, remote);
    // dims merge to { a: 0.6, b: 0.9 } → mean 0.75
    expect(merged.overall).toBe(0.75);
  });

  it('carries gaps + lastCalculated from the more-recently-calculated side', () => {
    const local = { dimensions: { a: 0.5 }, gaps: [{ dimension: 'a' }], lastCalculated: '2026-01-01' };
    const remote = { dimensions: { a: 0.5 }, gaps: [{ dimension: 'b' }], lastCalculated: '2026-02-01' };
    const { merged } = mergeConfidence(local, remote);
    expect(merged.gaps).toEqual([{ dimension: 'b' }]);
    expect(merged.lastCalculated).toBe('2026-02-01');
  });
});

describe('mergeMeta wires confidence', () => {
  it('brings over a peer\'s analyzed traits into a fresh local meta', () => {
    const local = { documents: [], confidence: { dimensions: {}, overall: 0, gaps: [], lastCalculated: '' } };
    const remote = { documents: [], confidence: { dimensions: { openness: 0.7 }, overall: 0.7, gaps: [], lastCalculated: '2026-03-01' } };
    const { merged, changed } = mergeMeta(local, remote);
    expect(changed).toBe(true);
    expect(merged.confidence.dimensions.openness).toBe(0.7);
    expect(merged.confidence.lastCalculated).toBe('2026-03-01');
  });

  it('does not blank local confidence when the peer sends none', () => {
    const local = { documents: [], confidence: { dimensions: { openness: 0.7 }, overall: 0.7, lastCalculated: '2026-03-01' } };
    const { merged } = mergeMeta(local, { documents: [] });
    expect(merged.confidence.dimensions.openness).toBe(0.7);
  });
});

describe('mergeSocialAccounts', () => {
  it('takes remote when local is missing/invalid', () => {
    const remote = { accounts: { a1: { platform: 'github', updatedAt: '2026-01-01' } } };
    expect(mergeSocialAccounts(null, remote)).toEqual({ merged: remote, changed: true });
  });

  it('keeps local and reports no change when remote is missing', () => {
    const local = { accounts: { a1: { platform: 'github' } } };
    expect(mergeSocialAccounts(local, null).changed).toBe(false);
  });

  it('unions accounts by id, keeping each side\'s unique entries', () => {
    const local = { accounts: { a1: { platform: 'github', updatedAt: '2026-01-01' } } };
    const remote = { accounts: { a2: { platform: 'x', updatedAt: '2026-01-02' } } };
    const { merged, changed } = mergeSocialAccounts(local, remote);
    expect(Object.keys(merged.accounts).sort()).toEqual(['a1', 'a2']);
    expect(changed).toBe(true);
  });

  it('LWW on a shared account by updatedAt', () => {
    const local = { accounts: { a1: { username: 'old', updatedAt: '2026-01-01' } } };
    const remote = { accounts: { a1: { username: 'new', updatedAt: '2026-02-01' } } };
    expect(mergeSocialAccounts(local, remote).merged.accounts.a1.username).toBe('new');
    const older = { accounts: { a1: { username: 'older', updatedAt: '2025-12-01' } } };
    expect(mergeSocialAccounts(local, older).merged.accounts.a1.username).toBe('old');
    expect(mergeSocialAccounts(local, older).changed).toBe(false);
  });
});

describe('safeMdName (path-traversal guard)', () => {
  it('accepts a plain .md basename', () => {
    expect(safeMdName('SOUL.md')).toBe('SOUL.md');
    expect(safeMdName('My_Doc.MD')).toBe('My_Doc.MD');
  });
  it('rejects traversal, nested paths, dotfiles, and non-md', () => {
    expect(safeMdName('../evil.md')).toBeNull();
    expect(safeMdName('sub/dir/x.md')).toBeNull();
    expect(safeMdName('/abs/x.md')).toBeNull();
    expect(safeMdName('.hidden.md')).toBeNull();
    expect(safeMdName('notes.txt')).toBeNull();
    expect(safeMdName(42)).toBeNull();
  });
});
