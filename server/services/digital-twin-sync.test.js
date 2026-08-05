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
  mergeChronotypeObserved,
  safeMdName,
  TEST_HISTORY_KEYS,
} from './digital-twin-sync.js';

// Minimal shape of a digital-twin evaluation-run history entry — the real
// schemas (digitalTwinValidation.js) key each run on `runId`, never `id`.
const run = (runId, timestamp) => ({ runId, timestamp, providerId: 'example-provider', model: 'example-model', score: 0.5 });

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
  // Signal = a populated month window; empty = zeroed rollups (idle peer).
  const withSignal = (derivedAt, extra = {}) => ({
    source: 'observed', derivedAt,
    windows: { month: { listen: { total: 5 }, watch: { total: 0 } } },
    ...extra,
  });
  const empty = (derivedAt, extra = {}) => ({
    source: 'observed', derivedAt,
    windows: { month: { listen: { total: 0 }, watch: { total: 0 } } },
    ...extra,
  });
  const body = (derivedAt, extra = {}) => withSignal(derivedAt, extra);
  const interp = (generatedAt, text = 'x') => ({ text, generatedAt });

  it('LWW on derivedAt for the rollup body when both sides have signal', () => {
    const local = withSignal('2026-07-01T00:00:00Z', { windows: { month: { listen: { total: 1 }, watch: { total: 0 } } } });
    const remote = withSignal('2026-07-05T00:00:00Z', { windows: { month: { listen: { total: 9 }, watch: { total: 0 } } } });
    expect(mergeTasteObserved(local, remote).merged.windows.month.listen.total).toBe(9);
  });

  it('a populated record is never clobbered by a newer EMPTY one (idle peer)', () => {
    const local = withSignal('2026-07-01T00:00:00Z');
    const remoteEmptyNewer = empty('2026-07-09T00:00:00Z'); // newer, but no signal
    const { merged, changed } = mergeTasteObserved(local, remoteEmptyNewer);
    expect(merged.derivedAt).toBe('2026-07-01T00:00:00Z'); // local (populated) kept
    expect(changed).toBe(false);
  });

  it('a populated remote replaces an empty local regardless of recency', () => {
    const localEmptyNewer = empty('2026-07-09T00:00:00Z');
    const remotePopulatedOlder = withSignal('2026-07-01T00:00:00Z');
    expect(mergeTasteObserved(localEmptyNewer, remotePopulatedOlder).merged.windows.month.listen.total).toBe(5);
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

describe('mergeChronotypeObserved (#2156 — signal-aware LWW)', () => {
  const rec = (derivedAt, sampleSize, observedType) => ({ source: 'observed', derivedAt, sampleSize, observedType });
  it('LWW on derivedAt when both sides have activity', () => {
    const local = rec('2026-07-01T00:00:00Z', 40, 'morning');
    const remote = rec('2026-07-05T00:00:00Z', 60, 'evening');
    expect(mergeChronotypeObserved(local, remote).merged.observedType).toBe('evening');
  });
  it('a populated histogram is not clobbered by a newer empty one (sampleSize 0)', () => {
    const local = rec('2026-07-01T00:00:00Z', 40, 'morning');
    const remoteEmpty = rec('2026-07-09T00:00:00Z', 0, null);
    expect(mergeChronotypeObserved(local, remoteEmpty).merged.observedType).toBe('morning');
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

  // Regression guard for the whole class of bug behind #3529: a keyField that
  // no record actually carries must not silently collapse the array.
  it('keeps every record when NONE of them carry the key field', () => {
    const { merged } = unionByKey(
      [{ runId: 'a' }, { runId: 'b' }],
      [{ runId: 'c' }],
      'nonexistentKey'
    );
    expect(merged.map((x) => x.runId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('treats a blank-string key as unkeyed rather than collapsing on it', () => {
    const { merged } = unionByKey([{ id: '', v: 1 }, { id: '', v: 2 }], [], 'id');
    expect(merged).toHaveLength(2);
  });

  it('is idempotent for unkeyed records — re-merging the same remote adds nothing', () => {
    const local = [{ runId: 'a' }];
    const remote = [{ runId: 'b' }];
    const first = unionByKey(local, remote, 'nonexistentKey');
    const second = unionByKey(first.merged, remote, 'nonexistentKey');
    expect(second.merged).toHaveLength(2);
    expect(second.changed).toBe(false);
  });

  it('signature-matches unkeyed records regardless of property order', () => {
    const { merged, changed } = unionByKey([{ a: 1, b: 2 }], [{ b: 2, a: 1 }], 'id');
    expect(merged).toHaveLength(1);
    expect(changed).toBe(false);
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

  it('unions all four test histories by runId and personas by id', () => {
    const local = { testHistory: [run('t1', '2026-01-01T00:00:00.000Z')], personas: [{ id: 'p1' }] };
    const remote = {
      testHistory: [run('t2', '2026-01-02T00:00:00.000Z')],
      valuesTestHistory: [run('v1', '2026-01-01T00:00:00.000Z')],
      adversarialTestHistory: [run('a1', '2026-01-01T00:00:00.000Z')],
      multiTurnTestHistory: [run('m1', '2026-01-01T00:00:00.000Z')],
      personas: [{ id: 'p2' }],
    };
    const { merged } = mergeMeta(local, remote);
    expect(merged.testHistory.map((x) => x.runId).sort()).toEqual(['t1', 't2']);
    expect(merged.valuesTestHistory).toHaveLength(1);
    expect(merged.adversarialTestHistory).toHaveLength(1);
    expect(merged.multiTurnTestHistory).toHaveLength(1);
    expect(merged.personas.map((x) => x.id).sort()).toEqual(['p1', 'p2']);
  });

  // #3529: these arrays were unioned on 'id', which no run entry carries, so
  // every entry collided on the `undefined` map key and the merge collapsed
  // each history down to a single record on the FIRST peer sync.
  it('preserves multi-entry test histories from BOTH peers without collapsing', () => {
    const local = Object.fromEntries(TEST_HISTORY_KEYS.map((key) => [key, [
      run(`${key}-L1`, '2026-01-03T00:00:00.000Z'),
      run(`${key}-L2`, '2026-01-01T00:00:00.000Z'),
    ]]));
    const remote = Object.fromEntries(TEST_HISTORY_KEYS.map((key) => [key, [
      run(`${key}-R1`, '2026-01-04T00:00:00.000Z'),
      run(`${key}-R2`, '2026-01-02T00:00:00.000Z'),
    ]]));

    const { merged, changed } = mergeMeta(local, remote);
    expect(changed).toBe(true);
    for (const key of TEST_HISTORY_KEYS) {
      expect(merged[key].map((x) => x.runId).sort()).toEqual(
        [`${key}-L1`, `${key}-L2`, `${key}-R1`, `${key}-R2`].sort()
      );
    }
  });

  it('re-sorts a merged history newest-first so the readers\' slice(0, N) stays "most recent N"', () => {
    const local = { testHistory: [run('L1', '2026-01-03T00:00:00.000Z'), run('L2', '2026-01-01T00:00:00.000Z')] };
    const remote = { testHistory: [run('R1', '2026-01-04T00:00:00.000Z'), run('R2', '2026-01-02T00:00:00.000Z')] };
    const { merged } = mergeMeta(local, remote);
    expect(merged.testHistory.map((x) => x.runId)).toEqual(['R1', 'L1', 'R2', 'L2']);
  });

  it('orders same-timestamp runs identically on both peers (runId tiebreak)', () => {
    const a = run('aaa', '2026-01-01T00:00:00.000Z');
    const b = run('bbb', '2026-01-01T00:00:00.000Z');
    const onPeerA = mergeMeta({ testHistory: [a] }, { testHistory: [b] }).merged.testHistory;
    const onPeerB = mergeMeta({ testHistory: [b] }, { testHistory: [a] }).merged.testHistory;
    expect(onPeerA.map((x) => x.runId)).toEqual(['aaa', 'bbb']);
    expect(onPeerB.map((x) => x.runId)).toEqual(onPeerA.map((x) => x.runId));
  });

  it('sorts timestamp-less legacy runs last instead of ahead of dated ones', () => {
    const local = { testHistory: [{ runId: 'legacy' }] };
    const remote = { testHistory: [run('R1', '2026-01-04T00:00:00.000Z')] };
    const { merged } = mergeMeta(local, remote);
    expect(merged.testHistory.map((x) => x.runId)).toEqual(['R1', 'legacy']);
  });

  it('keeps the local copy of a run that both peers already have (add-only)', () => {
    const local = { testHistory: [{ ...run('shared', '2026-01-01T00:00:00.000Z'), score: 0.9 }] };
    const remote = { testHistory: [{ ...run('shared', '2026-01-01T00:00:00.000Z'), score: 0.1 }] };
    const { merged, changed } = mergeMeta(local, remote);
    expect(merged.testHistory).toHaveLength(1);
    expect(merged.testHistory[0].score).toBe(0.9);
    expect(changed).toBe(false);
  });

  // #3530: documents unioned add-only with no deletion tracking, so a peer that
  // still held a document the user deleted re-inserted its metadata entry (and
  // applyDocuments re-wrote the .md file) on every subsequent sync.
  describe('deleted-document tombstones (#3530)', () => {
    const DELETED_AT = '2026-02-01T00:00:00.000Z';
    const tomb = (filename, deletedAt = DELETED_AT) => ({ filename, deletedAt });
    const doc = (filename, extra = {}) => ({ id: `id-${filename}`, filename, weight: 5, ...extra });

    it('does not resurrect a document the local machine deleted', () => {
      const local = { documents: [doc('SOUL.md')], deletedDocuments: [tomb('CUSTOM_ROUTINE.md')] };
      const remote = { documents: [doc('SOUL.md'), doc('CUSTOM_ROUTINE.md', { createdAt: '2026-01-01T00:00:00.000Z' })] };
      const { merged, changed } = mergeMeta(local, remote);
      expect(merged.documents.map((d) => d.filename)).toEqual(['SOUL.md']);
      expect(changed).toBe(false);
    });

    it('suppresses a resurrected document that carries no creation stamp (legacy entry)', () => {
      const local = { documents: [], deletedDocuments: [tomb('CUSTOM_ROUTINE.md')] };
      const { merged, changed } = mergeMeta(local, { documents: [doc('CUSTOM_ROUTINE.md')] });
      expect(merged.documents ?? []).toEqual([]);
      expect(changed).toBe(false);
    });

    it('propagates a peer\'s delete: drops the local entry and adopts the tombstone', () => {
      const local = { documents: [doc('CUSTOM_ROUTINE.md', { createdAt: '2026-01-01T00:00:00.000Z' })], deletedDocuments: [] };
      const remote = { documents: [], deletedDocuments: [tomb('CUSTOM_ROUTINE.md')] };
      const { merged, changed } = mergeMeta(local, remote);
      expect(merged.documents).toEqual([]);
      expect(merged.deletedDocuments).toEqual([tomb('CUSTOM_ROUTINE.md')]);
      expect(changed).toBe(true);
    });

    it('does NOT suppress a document re-created after the delete, and prunes the stale tombstone', () => {
      const recreated = doc('CUSTOM_ROUTINE.md', { createdAt: '2026-03-01T00:00:00.000Z' });
      // The peer still holds the tombstone from the earlier delete.
      const local = { documents: [recreated], deletedDocuments: [] };
      const remote = { documents: [], deletedDocuments: [tomb('CUSTOM_ROUTINE.md')] };
      const { merged, changed } = mergeMeta(local, remote);
      expect(merged.documents ?? local.documents).toEqual([recreated]);
      expect(merged.deletedDocuments ?? []).toEqual([]);
      expect(changed).toBe(false);
      // …and the peer receiving the re-created doc accepts it, dropping its own tombstone.
      const onPeer = mergeMeta(remote, local);
      expect(onPeer.merged.documents).toEqual([recreated]);
      expect(onPeer.merged.deletedDocuments).toEqual([]);
      expect(onPeer.changed).toBe(true);
    });

    it('keeps the newer of two competing deletes and converges in both directions', () => {
      const a = { documents: [], deletedDocuments: [tomb('A.md', '2026-01-01T00:00:00.000Z')] };
      const b = { documents: [], deletedDocuments: [tomb('A.md', '2026-05-01T00:00:00.000Z'), tomb('B.md')] };
      expect(mergeMeta(a, b).merged.deletedDocuments)
        .toEqual(mergeMeta(b, a).merged.deletedDocuments ?? b.deletedDocuments);
      expect(mergeMeta(a, b).merged.deletedDocuments).toEqual([tomb('A.md', '2026-05-01T00:00:00.000Z'), tomb('B.md')]);
    });

    it('adopts the peer\'s newer creation stamp so a third peer\'s tombstone can\'t reap the re-created doc', () => {
      // This machine has the ORIGINAL entry; the peer re-created the document
      // after a delete. Without propagating the newer stamp, the stale local
      // entry would later be reaped by a third peer still holding the tombstone.
      const local = { documents: [doc('CUSTOM_ROUTINE.md', { createdAt: '2026-01-01T00:00:00.000Z', weight: 9 })] };
      const remote = { documents: [doc('CUSTOM_ROUTINE.md', { createdAt: '2026-03-01T00:00:00.000Z', weight: 1 })] };
      const { merged, changed } = mergeMeta(local, remote);
      expect(changed).toBe(true);
      expect(merged.documents[0].createdAt).toBe('2026-03-01T00:00:00.000Z');
      expect(merged.documents[0].weight).toBe(9); // the rest of the entry stays add-only

      // …and that refreshed entry now survives the stale tombstone.
      const third = { documents: [], deletedDocuments: [tomb('CUSTOM_ROUTINE.md')] };
      expect(mergeMeta(merged, third).merged.documents).toEqual(merged.documents);
    });

    it('does not reap a document edited after another machine deleted it', () => {
      const edited = doc('CUSTOM_ROUTINE.md', { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' });
      const { merged } = mergeMeta({ documents: [edited] }, { documents: [], deletedDocuments: [tomb('CUSTOM_ROUTINE.md')] });
      expect(merged.documents ?? [edited]).toEqual([edited]);
      // …and the superseded tombstone is pruned rather than retried every cycle.
      expect(merged.deletedDocuments ?? []).toEqual([]);
    });

    it('still reaps a document whose last edit predates the delete', () => {
      const stale = doc('CUSTOM_ROUTINE.md', { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-15T00:00:00.000Z' });
      const { merged } = mergeMeta({ documents: [stale] }, { documents: [], deletedDocuments: [tomb('CUSTOM_ROUTINE.md')] });
      expect(merged.documents).toEqual([]);
      expect(merged.deletedDocuments).toEqual([tomb('CUSTOM_ROUTINE.md')]);
    });

    it('leaves local tombstones untouched when an older peer sends none (key-presence guarded)', () => {
      const local = { documents: [doc('SOUL.md')], deletedDocuments: [tomb('GONE.md')] };
      const { merged, changed } = mergeMeta(local, { documents: [doc('SOUL.md')] });
      expect(merged.deletedDocuments ?? local.deletedDocuments).toEqual([tomb('GONE.md')]);
      expect(changed).toBe(false);
    });
  });

  it('leaves histories the peer did not send untouched (key-presence guarded)', () => {
    const local = { testHistory: [run('L1', '2026-01-01T00:00:00.000Z'), run('L2', '2026-01-02T00:00:00.000Z')] };
    const { merged, changed } = mergeMeta(local, { documents: [] });
    expect(merged.testHistory.map((x) => x.runId)).toEqual(['L1', 'L2']);
    expect(changed).toBe(false);
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
