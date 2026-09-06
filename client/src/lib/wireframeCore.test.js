import { describe, it, expect, vi } from 'vitest';
import {
  ICOSAHEDRON_EDGES,
  ICOSAHEDRON_VERTICES,
  drawWireframeCore,
  projectIcosahedron,
  rotatePoint,
} from './wireframeCore.js';

describe('icosahedron geometry', () => {
  it('has 12 vertices joined by 30 edges, five per vertex', () => {
    expect(ICOSAHEDRON_VERTICES).toHaveLength(12);
    expect(ICOSAHEDRON_EDGES).toHaveLength(30);
    const degree = new Array(12).fill(0);
    for (const [a, b] of ICOSAHEDRON_EDGES) { degree[a]++; degree[b]++; }
    expect(degree.every((d) => d === 5)).toBe(true);
  });

  it('rotation preserves length and a quarter turn about Y maps x onto z', () => {
    const [x, y, z] = rotatePoint([1, 2, 3], 0.7, -1.3);
    expect(Math.hypot(x, y, z)).toBeCloseTo(Math.hypot(1, 2, 3), 10);
    const [qx, , qz] = rotatePoint([1, 0, 0], 0, Math.PI / 2);
    expect(qx).toBeCloseTo(0, 10);
    expect(qz).toBeCloseTo(1, 10);
  });

  it('projects nearer vertices larger than farther ones around the canvas center', () => {
    const proj = projectIcosahedron({ ax: 0, ay: 0, cx: 100, cy: 100, scale: 30 });
    expect(proj).toHaveLength(12);
    // Vertex 5 (0, 1, φ) sits behind the camera plane, vertex 7 (0, 1, -φ) in front:
    // same y, so the front one must land farther from center (bigger perspective).
    const back = proj[5];
    const front = proj[7];
    expect(front[2]).toBeLessThan(0);
    expect(back[2]).toBeGreaterThan(0);
    expect(Math.abs(front[1] - 100)).toBeGreaterThan(Math.abs(back[1] - 100));
  });
});

describe('drawWireframeCore', () => {
  const fakeCtx = () => ({
    clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), setLineDash: vi.fn(), fillText: vi.fn(),
    strokeStyle: '', fillStyle: '', lineWidth: 0, shadowColor: '', shadowBlur: 0, font: '',
  });
  const frame = {
    ax: 0.3, ay: 1.1, phase: 0.2, edgeRgb: [0, 240, 255], nodeRgb: [255, 43, 214], dimRgb: [107, 115, 144],
  };

  it('strokes every edge and fills every vertex in the state color', () => {
    const ctx = fakeCtx();
    drawWireframeCore(ctx, { ...frame, width: 200, height: 200 });
    // 2 rings + 30 edges strokes; 12 vertex fills.
    expect(ctx.stroke).toHaveBeenCalledTimes(32);
    expect(ctx.fill).toHaveBeenCalledTimes(12);
    expect(ctx.fillText).toHaveBeenCalledWith(expect.stringMatching(/^ICO-12 · \d{3}°$/), 8, 192);
    // Glow is the edge color, and the last stroke style written was an edge or ring.
    expect(ctx.shadowColor).toMatch(/^rgba\(0,240,255,/);
  });

  it('drops the corner readout in a tile too small to hold it', () => {
    const ctx = fakeCtx();
    drawWireframeCore(ctx, { ...frame, width: 96, height: 110 });
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalledTimes(32);
  });
});
// @vitest-environment node
