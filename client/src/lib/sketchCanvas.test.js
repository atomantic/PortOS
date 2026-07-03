import { describe, it, expect, vi } from 'vitest';
import {
  createStroke, appendPoint, undoStrokes, clampSize, drawStrokes,
  DEFAULT_COLOR, DEFAULT_SIZE, MIN_SIZE, MAX_SIZE,
} from './sketchCanvas';

describe('sketchCanvas stroke model', () => {
  it('clampSize bounds and rounds; falls back on garbage', () => {
    expect(clampSize(1000)).toBe(MAX_SIZE);
    expect(clampSize(-5)).toBe(MIN_SIZE);
    expect(clampSize(6.7)).toBe(7);
    expect(clampSize('abc')).toBe(DEFAULT_SIZE);
  });

  it('createStroke seeds a single point and normalizes mode/size', () => {
    const s = createStroke({ mode: 'erase', color: '#fff', size: 9999, x: 2, y: 3 });
    expect(s.mode).toBe('erase');
    expect(s.color).toBe('#fff');
    expect(s.size).toBe(MAX_SIZE);
    expect(s.points).toEqual([{ x: 2, y: 3 }]);

    const d = createStroke({ x: 0, y: 0 });
    expect(d.mode).toBe('draw');
    expect(d.color).toBe(DEFAULT_COLOR);
    expect(d.size).toBe(DEFAULT_SIZE);
  });

  it('appendPoint returns a new stroke (immutable) with the point added', () => {
    const s = createStroke({ x: 0, y: 0 });
    const s2 = appendPoint(s, 5, 6);
    expect(s2).not.toBe(s);
    expect(s.points).toHaveLength(1); // original untouched
    expect(s2.points).toEqual([{ x: 0, y: 0 }, { x: 5, y: 6 }]);
  });

  it('undoStrokes pops the last stroke, no-ops on empty', () => {
    const a = createStroke({ x: 0, y: 0 });
    const b = createStroke({ x: 1, y: 1 });
    expect(undoStrokes([a, b])).toEqual([a]);
    const empty = [];
    expect(undoStrokes(empty)).toBe(empty);
  });
});

describe('drawStrokes renderer', () => {
  const makeCtx = () => ({
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), clearRect: vi.fn(),
    lineJoin: '', lineCap: '', lineWidth: 0, globalCompositeOperation: '', strokeStyle: '', fillStyle: '',
  });

  it('clears then draws a polyline for a multi-point draw stroke', () => {
    const ctx = makeCtx();
    const stroke = { mode: 'draw', color: '#f00', size: 4, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] };
    drawStrokes(ctx, [stroke], 10, 10);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 10, 10);
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('draws a dot (arc+fill) for a single-point stroke', () => {
    const ctx = makeCtx();
    drawStrokes(ctx, [{ mode: 'draw', color: '#0f0', size: 8, points: [{ x: 3, y: 3 }] }], 10, 10);
    expect(ctx.arc).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.stroke).not.toHaveBeenCalled();
  });

  it('erase strokes use destination-out compositing', () => {
    const ctx = makeCtx();
    const composites = [];
    // Record the composite op at the moment stroke() is invoked.
    ctx.stroke = vi.fn(() => composites.push(ctx.globalCompositeOperation));
    drawStrokes(ctx, [{ mode: 'erase', size: 5, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], 10, 10);
    expect(composites).toContain('destination-out');
  });

  it('skips empty/invalid strokes without throwing', () => {
    const ctx = makeCtx();
    expect(() => drawStrokes(ctx, [null, { points: [] }, {}], 5, 5)).not.toThrow();
    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});
