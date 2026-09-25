import { describe, it, expect } from 'vitest';
import { squarifyTreemap } from './squarifyTreemap';

const area = (r) => r.w * r.h;

describe('squarifyTreemap', () => {
  it.each([
    [[6, 6, 4, 3, 2, 2, 1], 600, 400],
    [[100, 1, 1, 1], 300, 900],
    [[5], 200, 100],
    [[1, 1, 1, 1, 1, 1, 1, 1, 1], 90, 90],
  ])('tiles %j into %ix%i with proportional areas and no overflow', (values, width, height) => {
    const rects = squarifyTreemap(values.map((value) => ({ value })), width, height);
    const total = values.reduce((s, v) => s + v, 0);
    expect(rects).toHaveLength(values.length);
    for (const r of rects) {
      expect(area(r)).toBeCloseTo((r.item.value / total) * width * height, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(width + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(height + 1e-6);
    }
    expect(rects.reduce((s, r) => s + area(r), 0)).toBeCloseTo(width * height, 6);
  });

  it('keeps equal items close to square instead of slicing strips', () => {
    const rects = squarifyTreemap(Array.from({ length: 16 }, () => ({ value: 1 })), 400, 400);
    for (const r of rects) expect(Math.max(r.w / r.h, r.h / r.w)).toBeLessThan(2);
  });

  it('drops zero, negative, and non-numeric values and handles empty input', () => {
    const rects = squarifyTreemap([{ value: 0 }, { value: -3 }, { value: 'x' }, { value: 2 }], 100, 50);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 50 });
    expect(squarifyTreemap([], 100, 50)).toEqual([]);
    expect(squarifyTreemap([{ value: 1 }], 0, 50)).toEqual([]);
  });
});
