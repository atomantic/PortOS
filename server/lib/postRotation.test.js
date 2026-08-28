import { describe, it, expect } from 'vitest';
import { dayRotationIndex, orderByRecencyRotation } from './postRotation.js';

// The regression these guard: POST's practice tiers used to resolve equivalent
// candidates by input order, so one drill held the top slot every day. Rotation
// has to vary ACROSS days while staying reproducible WITHIN a day — a random
// pick would break "Continue Today's Routine", which re-requests the list.
describe('postRotation', () => {
  describe('dayRotationIndex', () => {
    it('advances by one candidate per local day and wraps', () => {
      expect(dayRotationIndex('2026-03-01', 3)).toBe(dayRotationIndex('2026-03-04', 3));
      const walk = ['2026-03-01', '2026-03-02', '2026-03-03'].map(day => dayRotationIndex(day, 3));
      expect([...new Set(walk)].sort()).toEqual([0, 1, 2]);
    });

    it('degrades to 0 rather than rotating off an unusable day or list', () => {
      expect(dayRotationIndex(null, 4)).toBe(0);
      expect(dayRotationIndex('not-a-day', 4)).toBe(0);
      expect(dayRotationIndex('2026-03-01', 1)).toBe(0);
      expect(dayRotationIndex('2026-03-01', 0)).toBe(0);
    });
  });

  describe('orderByRecencyRotation', () => {
    const dayKey = '2026-03-02';

    it('sinks recently-practiced candidates below fresh ones', () => {
      const order = orderByRecencyRotation(['a', 'b', 'c'], {
        dayKey,
        isRecent: (c) => c === 'a' || c === 'b',
      });
      expect(order[0]).toBe('c');
      expect(order).toHaveLength(3);
    });

    it('keeps a higher-priority candidate ahead of a rotation preference', () => {
      const ranked = [{ id: 'weak', rank: 0.2 }, { id: 'mid', rank: 0.6 }, { id: 'strong', rank: 0.9 }];
      for (const day of ['2026-03-01', '2026-03-02', '2026-03-03']) {
        expect(orderByRecencyRotation(ranked, { dayKey: day, rank: (c) => c.rank })[0].id).toBe('weak');
      }
    });

    it('rotates equally-ranked candidates across days but is stable within one day', () => {
      const list = ['alpha', 'beta', 'gamma'];
      const heads = ['2026-03-01', '2026-03-02', '2026-03-03'].map(day => orderByRecencyRotation(list, { dayKey: day })[0]);
      expect(new Set(heads).size).toBe(3);
      expect(orderByRecencyRotation(list, { dayKey })).toEqual(orderByRecencyRotation(list, { dayKey }));
    });

    it('still returns every candidate when all of them are recent, rotating among them', () => {
      const list = ['alpha', 'beta', 'gamma'];
      const order = orderByRecencyRotation(list, { dayKey, isRecent: () => true });
      expect([...order].sort()).toEqual([...list].sort());
      expect(order[0]).toBe(orderByRecencyRotation(list, { dayKey })[0]);
    });

    it('returns the only available candidate untouched, recent or not', () => {
      expect(orderByRecencyRotation(['solo'], { dayKey, isRecent: () => true })).toEqual(['solo']);
      expect(orderByRecencyRotation([], { dayKey })).toEqual([]);
      expect(orderByRecencyRotation(null, { dayKey })).toEqual([]);
    });

    it('falls back to input order when there is no usable day key', () => {
      const list = ['alpha', 'beta', 'gamma'];
      expect(orderByRecencyRotation(list, { dayKey: null })).toEqual(list);
    });
  });
});
