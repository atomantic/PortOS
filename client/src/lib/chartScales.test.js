import { expect, it } from 'vitest';
import { chartValue, linePath, numericAxis, stackBars } from './chartScales';

it('projects linear values and resolves callback bounds and nice ticks', () => {
  const axis = numericAxis({ domain: [min => min - 2, max => max + 2] }, [12, null, 18]);
  expect(axis.domain).toEqual([10, 20]);
  expect(axis.project(15)).toBe(0.5);
  expect(axis.ticks).toEqual([10, 12, 14, 16, 18, 20]);
});

it('maps decades evenly, clamps nonpositive values and preserves explicit ticks', () => {
  const ticks = [0.1, 1, 10, 100];
  const axis = numericAxis({ scale: 'log', domain: [0.1, 100], ticks }, []);
  expect(axis.ticks).toEqual(ticks);
  expect(axis.project(1)).toBeCloseTo(1 / 3);
  expect(axis.project(0)).toBe(0);
});

it('keeps a finite usable range for empty, constant and narrow log domains', () => {
  for (const data of [[], [0], [8], [21, 23]]) {
    const axis = numericAxis({ scale: 'log', domain: ['dataMin', 'dataMax'] }, data);
    expect(axis.domain[1]).toBeGreaterThan(axis.domain[0]);
    expect(Number.isFinite(axis.project(8))).toBe(true);
    expect(axis.ticks.length).toBeGreaterThan(0);
  }
});

it('preserves missing points, uses monotone or step segments, and indexes stacked data keys', () => {
  expect(chartValue({ 'example.1': 42 }, 'example.1')).toBe(42);
  expect(stackBars([{ values: [3, 5] }], [{ dataKey: 'values[0]', stackId: 'sum' }, { dataKey: 'values[1]', stackId: 'sum' }])).toEqual([[[0, 3], [3, 8]]]);
  const points = [[0, 1], [1, 2], null, [3, 1]];
  expect(linePath(points, 'stepAfter', false)).toBe('M0,1 H1V2 M3,1');
  expect(linePath(points, 'monotone', false)).toMatch(/^M0,1 C.+ M3,1$/);
  expect(linePath(points, 'linear', true)).toBe('M0,1 L1,2 L3,1');
});
