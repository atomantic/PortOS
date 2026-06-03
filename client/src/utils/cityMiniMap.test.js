import { describe, it, expect } from 'vitest';
import {
  MINI_MAP_PADDING,
  computeBounds,
  projectPoint,
  computeMiniMap,
} from './cityMiniMap';

const pos = (x, z, district = 'downtown') => ({ x, z, district });

describe('computeBounds', () => {
  it('returns null for empty / non-array input', () => {
    expect(computeBounds([])).toBeNull();
    expect(computeBounds(undefined)).toBeNull();
    expect(computeBounds(null)).toBeNull();
  });

  it('computes the min/max box for many points', () => {
    const b = computeBounds([pos(-12, 0), pos(0, -12), pos(12, 12), pos(0, 0)]);
    expect(b).toEqual({ minX: -12, maxX: 12, minZ: -12, maxZ: 12 });
  });

  it('collapses to a zero-span box for a single point', () => {
    const b = computeBounds([pos(5, -3)]);
    expect(b).toEqual({ minX: 5, maxX: 5, minZ: -3, maxZ: -3 });
  });
});

describe('projectPoint', () => {
  const bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  const p = MINI_MAP_PADDING;
  const usable = 1 - 2 * p;

  it('maps the min corner to the padded top-left', () => {
    const { nx, ny } = projectPoint(pos(-10, -10), bounds);
    expect(nx).toBeCloseTo(p);
    expect(ny).toBeCloseTo(p);
  });

  it('maps the max corner to the padded bottom-right', () => {
    const { nx, ny } = projectPoint(pos(10, 10), bounds);
    expect(nx).toBeCloseTo(p + usable);
    expect(ny).toBeCloseTo(p + usable);
  });

  it('maps the center to the middle of the box', () => {
    const { nx, ny } = projectPoint(pos(0, 0), bounds);
    expect(nx).toBeCloseTo(0.5);
    expect(ny).toBeCloseTo(0.5);
  });

  it('maps +x right and +z down (top-down floor plan)', () => {
    const right = projectPoint(pos(10, 0), bounds);
    const left = projectPoint(pos(-10, 0), bounds);
    const down = projectPoint(pos(0, 10), bounds);
    const up = projectPoint(pos(0, -10), bounds);
    expect(right.nx).toBeGreaterThan(left.nx);
    expect(down.ny).toBeGreaterThan(up.ny);
  });

  it('centers a point along a zero-span axis instead of dividing by zero', () => {
    const colBounds = { minX: 5, maxX: 5, minZ: -10, maxZ: 10 };
    const { nx, ny } = projectPoint(pos(5, 0), colBounds);
    expect(nx).toBeCloseTo(0.5); // x span is zero → centered
    expect(ny).toBeCloseTo(0.5); // z span resolves normally
  });

  it('clamps out-of-bounds points into [0, 1]', () => {
    const { nx, ny } = projectPoint(pos(1000, -1000), bounds);
    expect(nx).toBeGreaterThanOrEqual(0);
    expect(nx).toBeLessThanOrEqual(1);
    expect(ny).toBeGreaterThanOrEqual(0);
    expect(ny).toBeLessThanOrEqual(1);
  });

  it('falls back to center when bounds are null', () => {
    expect(projectPoint(pos(3, 7), null)).toEqual({ nx: 0.5, ny: 0.5 });
  });
});

describe('computeMiniMap', () => {
  const positions = (entries) => new Map(entries.map(([id, x, z, district]) => [id, pos(x, z, district)]));

  it('returns an empty, bounds-null view for no apps', () => {
    const vm = computeMiniMap([], new Map());
    expect(vm.empty).toBe(true);
    expect(vm.count).toBe(0);
    expect(vm.dots).toEqual([]);
    expect(vm.bounds).toBeNull();
  });

  it('tolerates non-array apps / non-Map positions', () => {
    const vm = computeMiniMap(undefined, undefined);
    expect(vm.empty).toBe(true);
    expect(vm.count).toBe(0);
  });

  it('plots a single app at the center', () => {
    const apps = [{ id: 'a', name: 'Alpha', overallStatus: 'online' }];
    const vm = computeMiniMap(apps, positions([['a', 0, 0]]));
    expect(vm.count).toBe(1);
    expect(vm.empty).toBe(false);
    expect(vm.dots[0].nx).toBeCloseTo(0.5);
    expect(vm.dots[0].ny).toBeCloseTo(0.5);
    expect(vm.dots[0].status).toBe('online');
  });

  it('projects many apps within the padded box and preserves order', () => {
    const apps = [
      { id: 'a', overallStatus: 'online' },
      { id: 'b', overallStatus: 'stopped' },
      { id: 'c', overallStatus: 'online' },
    ];
    const vm = computeMiniMap(apps, positions([['a', -12, -12], ['b', 12, 12], ['c', 0, 0]]));
    expect(vm.count).toBe(3);
    expect(vm.dots.map(d => d.id)).toEqual(['a', 'b', 'c']);
    for (const d of vm.dots) {
      expect(d.nx).toBeGreaterThanOrEqual(0);
      expect(d.nx).toBeLessThanOrEqual(1);
      expect(d.ny).toBeGreaterThanOrEqual(0);
      expect(d.ny).toBeLessThanOrEqual(1);
    }
  });

  it('marks archived apps with the archived status regardless of overallStatus', () => {
    const apps = [{ id: 'a', overallStatus: 'online', archived: true }];
    const vm = computeMiniMap(apps, positions([['a', 0, 0, 'warehouse']]));
    expect(vm.dots[0].status).toBe('archived');
    expect(vm.dots[0].archived).toBe(true);
    expect(vm.dots[0].district).toBe('warehouse');
  });

  it('defaults a missing status to not_started', () => {
    const apps = [{ id: 'a' }];
    const vm = computeMiniMap(apps, positions([['a', 0, 0]]));
    expect(vm.dots[0].status).toBe('not_started');
  });

  it('falls back to the id when an app has no name', () => {
    const apps = [{ id: 'svc-42', overallStatus: 'online' }];
    const vm = computeMiniMap(apps, positions([['svc-42', 0, 0]]));
    expect(vm.dots[0].name).toBe('svc-42');
  });

  it('skips apps that have no layout position', () => {
    const apps = [
      { id: 'a', overallStatus: 'online' },
      { id: 'ghost', overallStatus: 'online' },
    ];
    const vm = computeMiniMap(apps, positions([['a', 0, 0]]));
    expect(vm.count).toBe(1);
    expect(vm.dots.map(d => d.id)).toEqual(['a']);
  });
});
