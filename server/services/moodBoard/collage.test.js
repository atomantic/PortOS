import { describe, it, expect } from 'vitest';
import { squareGridDims, frameSampleTimes } from './collage.js';

describe('squareGridDims', () => {
  it.each([
    [1, 1, 1], [2, 2, 1], [4, 2, 2], [5, 3, 2], [9, 3, 3], [10, 4, 3], [16, 4, 4], [17, 5, 4],
  ])('%i cells → %i cols × %i rows', (n, cols, rows) => {
    expect(squareGridDims(n)).toEqual({ cols, rows });
  });

  it('never leaves a wholly empty row and always covers the count', () => {
    for (let n = 1; n <= 200; n++) {
      const { cols, rows } = squareGridDims(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      expect((rows - 1) * cols).toBeLessThan(n);
      expect(cols - rows).toBeGreaterThanOrEqual(0);
      expect(cols - rows).toBeLessThanOrEqual(1);
    }
  });
});

describe('frameSampleTimes', () => {
  it('samples segment midpoints, staying inside the clip', () => {
    expect(frameSampleTimes(10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(frameSampleTimes(5, 1)).toEqual([2.5]);
  });
});
