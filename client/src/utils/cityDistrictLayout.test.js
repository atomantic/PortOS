import { describe, it, expect } from 'vitest';
import {
  autoColumns,
  gridIndexToPosition,
  tallyByKey,
  groupByFieldValue,
  scaleMetricToHeight,
} from './cityDistrictLayout';

describe('autoColumns', () => {
  it('returns a roughly-square column count', () => {
    expect(autoColumns(0)).toBe(1); // empty grid still has a valid column
    expect(autoColumns(1)).toBe(1);
    expect(autoColumns(4)).toBe(2);
    expect(autoColumns(5)).toBe(3); // ceil(sqrt(5)) = 3
    expect(autoColumns(9)).toBe(3);
    expect(autoColumns(10)).toBe(4);
  });

  it('floors at 1 for negative / NaN input', () => {
    expect(autoColumns(-3)).toBe(1);
    expect(autoColumns(NaN)).toBe(1);
  });
});

describe('gridIndexToPosition', () => {
  it('wraps into columns and centers X', () => {
    const opts = { columns: 3, spacing: 2, base: [0, 0, 0] };
    // 3 columns, spacing 2 → X offset = (3-1)*2/2 = 2, so cols sit at -2, 0, +2
    expect(gridIndexToPosition(0, opts)).toEqual([-2, 0, 0]);
    expect(gridIndexToPosition(1, opts)).toEqual([0, 0, 0]);
    expect(gridIndexToPosition(2, opts)).toEqual([2, 0, 0]);
    // index 3 wraps to row 1, col 0 → rows extend toward +Z by default
    expect(gridIndexToPosition(3, opts)).toEqual([-2, 0, 2]);
  });

  it('carries base x/y/z through', () => {
    const p = gridIndexToPosition(0, { columns: 1, spacing: 1, base: [5, 7, 9] });
    expect(p).toEqual([5, 7, 9]); // single column → no X offset
  });

  it('lays rows toward -Z when rowDir is -1 (jira yard)', () => {
    const opts = { columns: 2, spacing: 3, base: [0, 0, 0], rowDir: -1 };
    expect(gridIndexToPosition(2, opts)).toEqual([-1.5, 0, -3]); // row 1 recedes to -Z
  });

  it('centers rows on Z when rowCount is given (downtown)', () => {
    // 4 items, 2 cols → 2 rows, spacing 2 → Z offset = (2-1)*2/2 = 1, rows at -1 and +1
    const opts = { columns: 2, spacing: 2, base: [0, 0, 0], rowCount: 2 };
    expect(gridIndexToPosition(0, opts)).toEqual([-1, 0, -1]);
    expect(gridIndexToPosition(2, opts)).toEqual([-1, 0, 1]);
  });
});

describe('tallyByKey', () => {
  it('counts items into buckets by key', () => {
    const items = [{ s: 'a' }, { s: 'b' }, { s: 'a' }];
    expect(tallyByKey(items, (i) => i.s)).toEqual({ a: 2, b: 1 });
  });

  it('seeds fixed buckets to zero so absent keys are present', () => {
    expect(tallyByKey([], (i) => i.s, ['a', 'b'])).toEqual({ a: 0, b: 0 });
    const items = [{ s: 'a' }];
    expect(tallyByKey(items, (i) => i.s, ['a', 'b', 'c'])).toEqual({ a: 1, b: 0, c: 0 });
  });

  it('tolerates a non-array input', () => {
    expect(tallyByKey(null, (i) => i.s, ['a'])).toEqual({ a: 0 });
    expect(tallyByKey(undefined, (i) => i.s)).toEqual({});
  });
});

describe('groupByFieldValue', () => {
  it('groups, counts, and sums weight, sorted by count desc then key asc', () => {
    const items = [
      { c: 'work', w: 2 },
      { c: 'home', w: 5 },
      { c: 'work', w: 3 },
    ];
    const out = groupByFieldValue(items, (i) => i.c, { weightFn: (i) => i.w });
    expect(out).toEqual([
      { key: 'work', count: 2, weight: 5 },
      { key: 'home', count: 1, weight: 5 },
    ]);
  });

  it('defaults weight to 1 per item when no weightFn', () => {
    const items = [{ c: 'x' }, { c: 'x' }, { c: 'y' }];
    expect(groupByFieldValue(items, (i) => i.c)).toEqual([
      { key: 'x', count: 2, weight: 2 },
      { key: 'y', count: 1, weight: 1 },
    ]);
  });

  it('treats a non-finite weight as 0 contribution', () => {
    const items = [{ c: 'x', w: NaN }, { c: 'x', w: 4 }];
    const out = groupByFieldValue(items, (i) => i.c, { weightFn: (i) => i.w });
    expect(out).toEqual([{ key: 'x', count: 2, weight: 4 }]);
  });

  it('breaks count ties by key ascending', () => {
    const items = [{ c: 'b' }, { c: 'a' }];
    expect(groupByFieldValue(items, (i) => i.c).map((b) => b.key)).toEqual(['a', 'b']);
  });

  it('seeds buckets so an empty group still appears', () => {
    expect(groupByFieldValue([], (i) => i.c, { seed: ['a'] })).toEqual([
      { key: 'a', count: 0, weight: 0 },
    ]);
  });
});

describe('scaleMetricToHeight', () => {
  it('log-scales and clamps to the band', () => {
    // base 0.9 + log2(1+1)*1.1 = 0.9 + 1.1 = 2.0
    expect(scaleMetricToHeight(1, { max: 4.5, k: 1.1, base: 0.9 })).toBeCloseTo(2.0);
    // clamps at max
    expect(scaleMetricToHeight(1000, { max: 4.5, k: 1.1, base: 0.9 })).toBe(4.5);
  });

  it('floors value at 0 → yields exactly base', () => {
    expect(scaleMetricToHeight(0, { min: 1.2, max: 4.5, k: 0.7, base: 1.2 })).toBe(1.2);
    expect(scaleMetricToHeight(-9, { min: 1.2, max: 4.5, k: 0.7, base: 1.2 })).toBe(1.2);
    expect(scaleMetricToHeight(NaN, { base: 3 })).toBe(3);
  });

  it('respects the min clamp', () => {
    expect(scaleMetricToHeight(0, { min: 2, base: 0 })).toBe(2);
  });
});
