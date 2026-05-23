import { describe, it, expect, beforeEach } from 'vitest';
import { applyVolumeOrderedNumbers, UNSCOPED_ANCHOR } from './pipelineIssueOrder.js';

// Deterministic counter for auto-generated ids — keeps test failures readable
// (no randomized ids in error messages) and avoids any future test
// accidentally depending on Math.random ordering.
let _issueIdCounter = 0;
beforeEach(() => { _issueIdCounter = 0; });

const mkIssue = (over = {}) => ({
  id: over.id || `i${++_issueIdCounter}`,
  seriesId: 's1',
  seasonId: over.seasonId ?? null,
  arcPosition: over.arcPosition ?? 1,
  createdAt: over.createdAt || '2024-01-01T00:00:00Z',
  number: over.number ?? 0,
  ...over
});

describe('applyVolumeOrderedNumbers', () => {
  it('numbers issues volume-by-volume in season order', () => {
    const seasons = [
      { id: 'v1', number: 1 },
      { id: 'v2', number: 2 }
    ];
    const issues = [
      mkIssue({ id: 'a', seasonId: 'v2', arcPosition: 1 }),
      mkIssue({ id: 'b', seasonId: 'v1', arcPosition: 2 }),
      mkIssue({ id: 'c', seasonId: 'v1', arcPosition: 1 })
    ];

    const changed = applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons });

    expect(changed).toBe(true);
    expect(issues.find(i => i.id === 'c').number).toBe(1);
    expect(issues.find(i => i.id === 'b').number).toBe(2);
    expect(issues.find(i => i.id === 'a').number).toBe(3);
  });

  it('sorts within a volume by arcPosition then createdAt', () => {
    const seasons = [{ id: 'v1', number: 1 }];
    const issues = [
      mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1, createdAt: '2024-03-01T00:00:00Z' }),
      mkIssue({ id: 'b', seasonId: 'v1', arcPosition: 1, createdAt: '2024-01-01T00:00:00Z' }),
      mkIssue({ id: 'c', seasonId: 'v1', arcPosition: 0, createdAt: '2024-06-01T00:00:00Z' })
    ];
    applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons });
    // arcPosition 0 first; then arcPosition 1 sorted by createdAt
    expect(issues.find(i => i.id === 'c').number).toBe(1);
    expect(issues.find(i => i.id === 'b').number).toBe(2);
    expect(issues.find(i => i.id === 'a').number).toBe(3);
  });

  it('appends unscoped issues after volume issues, ordered by createdAt', () => {
    const seasons = [{ id: 'v1', number: 1 }];
    const issues = [
      mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1 }),
      mkIssue({ id: 'u2', seasonId: null, createdAt: '2024-02-01T00:00:00Z' }),
      mkIssue({ id: 'u1', seasonId: null, createdAt: '2024-01-01T00:00:00Z' })
    ];
    applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons });
    expect(issues.find(i => i.id === 'a').number).toBe(1);
    expect(issues.find(i => i.id === 'u1').number).toBe(2);
    expect(issues.find(i => i.id === 'u2').number).toBe(3);
  });

  it('treats issues with a stale seasonId as unscoped', () => {
    const seasons = [{ id: 'v1', number: 1 }];
    const issues = [
      mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1 }),
      mkIssue({ id: 'b', seasonId: 'v-gone', createdAt: '2024-01-01T00:00:00Z' })
    ];
    applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons });
    expect(issues.find(i => i.id === 'a').number).toBe(1);
    expect(issues.find(i => i.id === 'b').number).toBe(2);
  });

  it('skips issues that belong to other series', () => {
    const seasons = [{ id: 'v1', number: 1 }];
    const issues = [
      mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1 }),
      { id: 'x', seriesId: 'other', seasonId: 'v1', arcPosition: 1, createdAt: '', number: 99 }
    ];
    applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons });
    expect(issues.find(i => i.id === 'a').number).toBe(1);
    // Other-series issue is untouched
    expect(issues.find(i => i.id === 'x').number).toBe(99);
  });

  it('returns false when no numbers change', () => {
    const seasons = [{ id: 'v1', number: 1 }];
    const issues = [
      mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1, number: 1 }),
      mkIssue({ id: 'b', seasonId: 'v1', arcPosition: 2, number: 2 })
    ];
    const changed = applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons });
    expect(changed).toBe(false);
    expect(issues.find(i => i.id === 'a').number).toBe(1);
    expect(issues.find(i => i.id === 'b').number).toBe(2);
  });

  describe('fromSeasonId anchor', () => {
    it('with null anchor, renumbers the whole series', () => {
      const seasons = [
        { id: 'v1', number: 1 },
        { id: 'v2', number: 2 }
      ];
      const issues = [
        mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1, number: 9 }),
        mkIssue({ id: 'b', seasonId: 'v2', arcPosition: 1, number: 9 })
      ];
      applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons, fromSeasonId: null });
      expect(issues.find(i => i.id === 'a').number).toBe(1);
      expect(issues.find(i => i.id === 'b').number).toBe(2);
    });

    it('preserves earlier-volume numbers when anchor is on a later volume', () => {
      const seasons = [
        { id: 'v1', number: 1 },
        { id: 'v2', number: 2 }
      ];
      const issues = [
        // V1 already at #1 and #2 — must stay there even though we renumber from V2
        mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1, number: 1 }),
        mkIssue({ id: 'b', seasonId: 'v1', arcPosition: 2, number: 2 }),
        mkIssue({ id: 'c', seasonId: 'v2', arcPosition: 1, number: 0 })
      ];
      applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons, fromSeasonId: 'v2' });
      expect(issues.find(i => i.id === 'a').number).toBe(1);
      expect(issues.find(i => i.id === 'b').number).toBe(2);
      // Counter resumed from max(pre-anchor) + 1 = 3
      expect(issues.find(i => i.id === 'c').number).toBe(3);
    });

    it('UNSCOPED_ANCHOR only renumbers the trailing unscoped tail', () => {
      const seasons = [{ id: 'v1', number: 1 }];
      const issues = [
        mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1, number: 1 }),
        mkIssue({ id: 'u', seasonId: null, number: 0, createdAt: '2024-01-01T00:00:00Z' })
      ];
      applyVolumeOrderedNumbers({
        issues,
        seriesId: 's1',
        seasons,
        fromSeasonId: UNSCOPED_ANCHOR
      });
      // V1 untouched, only unscoped gets re-numbered after the seeded counter
      expect(issues.find(i => i.id === 'a').number).toBe(1);
      expect(issues.find(i => i.id === 'u').number).toBe(2);
    });

    it('treats a stale (unknown) fromSeasonId as UNSCOPED_ANCHOR', () => {
      const seasons = [{ id: 'v1', number: 1 }];
      const issues = [
        mkIssue({ id: 'a', seasonId: 'v1', arcPosition: 1, number: 1 }),
        mkIssue({ id: 'u', seasonId: null, number: 0, createdAt: '2024-01-01T00:00:00Z' })
      ];
      applyVolumeOrderedNumbers({
        issues,
        seriesId: 's1',
        seasons,
        fromSeasonId: 'stale-id-that-does-not-exist'
      });
      expect(issues.find(i => i.id === 'a').number).toBe(1);
      expect(issues.find(i => i.id === 'u').number).toBe(2);
    });
  });

  it('handles an empty seasons list with only unscoped issues', () => {
    const issues = [
      mkIssue({ id: 'u1', seasonId: null, createdAt: '2024-01-01T00:00:00Z' }),
      mkIssue({ id: 'u2', seasonId: null, createdAt: '2024-02-01T00:00:00Z' })
    ];
    applyVolumeOrderedNumbers({ issues, seriesId: 's1', seasons: [] });
    expect(issues.find(i => i.id === 'u1').number).toBe(1);
    expect(issues.find(i => i.id === 'u2').number).toBe(2);
  });
});
