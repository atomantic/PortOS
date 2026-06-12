import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from './rrfRanking.js';

const row = (id, extra = {}) => ({ id, ...extra });

describe('reciprocalRankFusion', () => {
  it('returns empty map for empty inputs', () => {
    expect(reciprocalRankFusion([], []).size).toBe(0);
    expect(reciprocalRankFusion(null, null).size).toBe(0);
    expect(reciprocalRankFusion(undefined, undefined).size).toBe(0);
  });

  it('scores FTS-only results', () => {
    const rrf = reciprocalRankFusion([row('a'), row('b')], []);
    expect(rrf.has('a')).toBe(true);
    expect(rrf.has('b')).toBe(true);
    const a = rrf.get('a');
    const b = rrf.get('b');
    // rank 1 > rank 2
    expect(a.rrfScore).toBeGreaterThan(b.rrfScore);
    expect(a.ftsRank).toBe(1);
    expect(a.vectorRank).toBeNull();
  });

  it('scores vector-only results', () => {
    const rrf = reciprocalRankFusion([], [row('x'), row('y')]);
    const x = rrf.get('x');
    const y = rrf.get('y');
    expect(x.rrfScore).toBeGreaterThan(y.rrfScore);
    expect(x.vectorRank).toBe(1);
    expect(x.ftsRank).toBeNull();
  });

  it('fuses scores when an item appears in both lists', () => {
    // 'shared' is rank 1 in FTS and rank 1 in vector
    // 'fts-only' is rank 2 in FTS
    // 'vec-only' is rank 2 in vector
    const rrf = reciprocalRankFusion(
      [row('shared'), row('fts-only')],
      [row('shared'), row('vec-only')],
    );
    const shared = rrf.get('shared');
    const ftsOnly = rrf.get('fts-only');
    const vecOnly = rrf.get('vec-only');
    // shared received both FTS and vector contributions
    expect(shared.rrfScore).toBeGreaterThan(ftsOnly.rrfScore);
    expect(shared.rrfScore).toBeGreaterThan(vecOnly.rrfScore);
    expect(shared.ftsRank).toBe(1);
    expect(shared.vectorRank).toBe(1);
  });

  it('respects custom k, ftsWeight, vectorWeight', () => {
    // With ftsWeight=1, vectorWeight=0: only FTS contributes
    const rrf = reciprocalRankFusion(
      [row('a')],
      [row('b')],
      { k: 60, ftsWeight: 1, vectorWeight: 0 },
    );
    const a = rrf.get('a');
    const b = rrf.get('b');
    expect(a.rrfScore).toBeGreaterThan(0);
    expect(b.rrfScore).toBe(0);
  });

  it('score is monotonically decreasing with rank', () => {
    const items = [row('a'), row('b'), row('c'), row('d')];
    const rrf = reciprocalRankFusion(items, []);
    const scores = ['a', 'b', 'c', 'd'].map((id) => rrf.get(id).rrfScore);
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i + 1]);
    }
  });

  it('handles tie in rank position (same index in both lists) correctly', () => {
    // Both lists have 'a' at rank 1 and 'b' at rank 2
    const rrf = reciprocalRankFusion(
      [row('a'), row('b')],
      [row('a'), row('b')],
      { k: 60, ftsWeight: 0.5, vectorWeight: 0.5 },
    );
    const a = rrf.get('a');
    const b = rrf.get('b');
    // 'a' has same rank across both lists as 'b' does — a ranks 1/1, b ranks 2/2
    // a should still score higher than b because 1/(60+1) > 1/(60+2)
    expect(a.rrfScore).toBeGreaterThan(b.rrfScore);
    // Both have contributions from both signals
    expect(a.ftsRank).toBe(1);
    expect(a.vectorRank).toBe(1);
    expect(b.ftsRank).toBe(2);
    expect(b.vectorRank).toBe(2);
  });

  it('preserves row data from first encounter', () => {
    const ftsRow = { id: 'x', rank: 0.9 };
    const vecRow = { id: 'x', similarity: 0.8 };
    const rrf = reciprocalRankFusion([ftsRow], [vecRow]);
    // FTS came first — row should be the FTS row
    expect(rrf.get('x').row).toBe(ftsRow);
  });

  it('returns correct ftsRank and vectorRank as 1-indexed', () => {
    const rrf = reciprocalRankFusion(
      [row('p'), row('q'), row('r')],
      [row('r'), row('p')],
    );
    expect(rrf.get('p').ftsRank).toBe(1);
    expect(rrf.get('p').vectorRank).toBe(2);
    expect(rrf.get('q').ftsRank).toBe(2);
    expect(rrf.get('q').vectorRank).toBeNull();
    expect(rrf.get('r').ftsRank).toBe(3);
    expect(rrf.get('r').vectorRank).toBe(1);
  });
});
