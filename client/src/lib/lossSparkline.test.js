import { describe, it, expect } from 'vitest';
import { lossSparklineGeometry } from './lossSparkline.js';

describe('lossSparklineGeometry', () => {
  it('returns empty points but the last value for a single point', () => {
    const geo = lossSparklineGeometry([{ step: 100, loss: 0.5 }]);
    expect(geo.points).toBe('');
    expect(geo.coords).toEqual([]);
    expect(geo.last).toBe(0.5);
  });

  it('normalizes a descending loss series to its own min/max', () => {
    // loss falls 1.0 → 0.0; higher loss sits higher (smaller y), so the first
    // point is at the top (y=0) and the last at the bottom (y=height).
    const geo = lossSparklineGeometry(
      [{ step: 0, loss: 1.0 }, { step: 50, loss: 0.5 }, { step: 100, loss: 0.0 }],
      { width: 200, height: 40 },
    );
    expect(geo.min).toBe(0);
    expect(geo.max).toBe(1);
    expect(geo.last).toBe(0);
    expect(geo.coords[0]).toMatchObject({ x: 0, y: 0 });
    expect(geo.coords[1]).toMatchObject({ x: 100, y: 20 });
    expect(geo.coords[2]).toMatchObject({ x: 200, y: 40 });
    expect(geo.points).toBe('0,0 100,20 200,40');
  });

  it('draws a flat line at mid-height when all losses are equal', () => {
    const geo = lossSparklineGeometry(
      [{ step: 0, loss: 0.3 }, { step: 10, loss: 0.3 }],
      { width: 100, height: 30 },
    );
    expect(geo.coords.every((c) => c.y === 15)).toBe(true);
  });

  it('ignores non-finite loss points', () => {
    const geo = lossSparklineGeometry([
      { step: 0, loss: 1 },
      { step: 1, loss: NaN },
      { step: 2, loss: null },
      { step: 3, loss: 0 },
    ], { width: 100, height: 20 });
    expect(geo.coords).toHaveLength(2);
    expect(geo.last).toBe(0);
  });

  it('returns a safe empty shape for empty / non-array input', () => {
    expect(lossSparklineGeometry([])).toMatchObject({ points: '', coords: [], last: null });
    expect(lossSparklineGeometry(null)).toMatchObject({ points: '', coords: [], last: null });
    expect(lossSparklineGeometry(undefined)).toMatchObject({ points: '', last: null });
  });
});
