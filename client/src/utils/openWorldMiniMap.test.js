import { describe, it, expect } from 'vitest';
import {
  MINI_MAP_PADDING,
  computeBounds,
  computeDistrictBounds,
  projectPoint,
  computeMiniMap,
  geographyWorldPoints,
  projectGeography,
  projectPlayer,
  projectLandmarks,
  spreadProjectedPoints,
} from './openWorldMiniMap';
import { ARCHIPELAGO_ISLANDS, ARCHIPELAGO_LINKS } from './openWorldPlan';

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

describe('computeDistrictBounds', () => {
  it('returns null when a populated layout has no entries in the requested district', () => {
    const positions = new Map([
      ['archived-a', { x: -6, z: 16, district: 'warehouse' }],
      ['archived-b', { x: 6, z: 16, district: 'warehouse' }],
    ]);

    expect(computeDistrictBounds(positions, 'downtown', { minCount: 2 })).toBeNull();
  });

  it('uses the canonical bounds reducer after applying the district and count gate', () => {
    const positions = new Map([
      ['a', { x: -4, z: 3, district: 'downtown' }],
      ['b', { x: 7, z: -2, district: 'downtown' }],
      ['archived', { x: 100, z: 100, district: 'warehouse' }],
    ]);

    expect(computeDistrictBounds(positions, 'downtown', { minCount: 2 })).toEqual({
      minX: -4,
      maxX: 7,
      minZ: -2,
      maxZ: 3,
    });
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

describe('spreadProjectedPoints', () => {
  it('keeps isolated points at their true projection', () => {
    const points = [{ id: 'a', nx: 0.2, ny: 0.2 }, { id: 'b', nx: 0.8, ny: 0.8 }];
    expect(spreadProjectedPoints(points)).toEqual(points);
  });

  it('fans colliding points into visible deterministic positions', () => {
    const points = Array.from({ length: 4 }, (_, index) => ({ id: String(index), nx: 0.5, ny: 0.5 }));
    const first = spreadProjectedPoints(points);
    const second = spreadProjectedPoints(points);
    expect(first).toEqual(second);
    expect(new Set(first.map((point) => `${point.nx}:${point.ny}`)).size).toBe(4);
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

  it('omits geography by default (pure building bounds)', () => {
    const apps = [{ id: 'a', overallStatus: 'online' }];
    const vm = computeMiniMap(apps, positions([['a', 0, 0]]));
    expect(vm.geography).toBeNull();
  });

  it('keeps the playable archipelago visible for an install with no app buildings', () => {
    const vm = computeMiniMap([], new Map(), { geography: true });
    expect(vm.geography).not.toBeNull();
    expect(vm.geography.islands).toHaveLength(ARCHIPELAGO_ISLANDS.length);
    expect(vm.bounds).not.toBeNull();
    expect(vm.empty).toBe(true);
  });

  it('folds the whole archipelago into the bounds when geography is enabled', () => {
    const apps = [{ id: 'a', overallStatus: 'online' }];
    const land = computeMiniMap(apps, positions([['a', 0, 0]]));
    const sea = computeMiniMap(apps, positions([['a', 0, 0]]), { geography: true });
    expect(sea.bounds.minZ).toBeLessThan(land.bounds.minZ);
    expect(sea.bounds.maxZ).toBeGreaterThan(land.bounds.maxZ);
    expect(sea.bounds.minX).toBeLessThan(land.bounds.minX);
    expect(sea.bounds.maxX).toBeGreaterThan(land.bounds.maxX);
    expect(sea.geography).not.toBeNull();
    expect(sea.geography.links).toHaveLength(ARCHIPELAGO_LINKS.length);
  });

  it('projects every island and every link inside the normalized map', () => {
    const apps = [
      { id: 'a', overallStatus: 'online' },
      { id: 'b', overallStatus: 'online' },
    ];
    const vm = computeMiniMap(apps, positions([['a', -20, 20], ['b', 20, 40]]), { geography: true });
    for (const island of vm.geography.islands) {
      for (const value of [island.nx, island.ny, island.radiusX, island.radiusY]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    for (const link of vm.geography.links) {
      expect(link.points.length).toBeGreaterThanOrEqual(2);
      link.points.forEach((point) => {
        expect(point.nx).toBeGreaterThanOrEqual(0);
        expect(point.nx).toBeLessThanOrEqual(1);
        expect(point.ny).toBeGreaterThanOrEqual(0);
        expect(point.ny).toBeLessThanOrEqual(1);
      });
    }
  });
});

describe('geographyWorldPoints', () => {
  it('returns four extrema for every island in the master plan', () => {
    const pts = geographyWorldPoints();
    expect(pts).toHaveLength(ARCHIPELAGO_ISLANDS.length * 4);
    ARCHIPELAGO_ISLANDS.forEach((island, index) => {
      const offset = index * 4;
      expect(pts[offset]).toEqual({ x: island.center[0] - island.radiusX, z: island.center[1] });
      expect(pts[offset + 1]).toEqual({ x: island.center[0] + island.radiusX, z: island.center[1] });
      expect(pts[offset + 2]).toEqual({ x: island.center[0], z: island.center[1] - island.radiusZ });
      expect(pts[offset + 3]).toEqual({ x: island.center[0], z: island.center[1] + island.radiusZ });
    });
  });
});

describe('projectGeography', () => {
  it('returns null when bounds are null', () => {
    expect(projectGeography(null)).toBeNull();
  });

  it('projects islands and links into normalized coordinates', () => {
    const bounds = { minX: -60, maxX: 60, minZ: -70, maxZ: 60 };
    const geo = projectGeography(bounds);
    expect(geo.islands).toHaveLength(ARCHIPELAGO_ISLANDS.length);
    expect(geo.links).toHaveLength(ARCHIPELAGO_LINKS.length);
    expect(geo.islands.find((island) => island.id === 'harbor')?.label).toBe('Data Harbor');
  });
});

describe('projectPlayer', () => {
  const bounds = { minX: -60, maxX: 60, minZ: -70, maxZ: 60 };

  it('projects player position and converts heading to degrees for clockwise CSS rotation', () => {
    const player = projectPlayer({ x: 0, z: 0 }, 0, bounds);
    expect(player).not.toBeNull();
    expect(player.nx).toBeCloseTo(0.5);
    expect(player.rotationDeg).toBeCloseTo(0);

    // Rover heading -π/2 (turning right / east / +X) corresponds to +90° clockwise CSS rotation:
    const playerEast = projectPlayer({ x: 10, z: -10 }, -Math.PI / 2, bounds);
    expect(playerEast.rotationDeg).toBeCloseTo(90);
  });

  it('returns null on invalid / absent inputs', () => {
    expect(projectPlayer(null, 0, bounds)).toBeNull();
    expect(projectPlayer({ x: 0, z: 0 }, 0, null)).toBeNull();
  });
});

describe('projectLandmarks', () => {
  const bounds = { minX: -60, maxX: 60, minZ: -70, maxZ: 60 };

  it('projects landmarks onto normalized coordinates', () => {
    const landmarks = projectLandmarks(bounds);
    expect(landmarks.length).toBeGreaterThanOrEqual(5);
    landmarks.forEach((lm) => {
      expect(typeof lm.id).toBe('string');
      expect(typeof lm.label).toBe('string');
      expect(lm.nx).toBeGreaterThanOrEqual(0);
      expect(lm.nx).toBeLessThanOrEqual(1);
      expect(lm.ny).toBeGreaterThanOrEqual(0);
      expect(lm.ny).toBeLessThanOrEqual(1);
    });
  });

  it('returns empty array when bounds are null', () => {
    expect(projectLandmarks(null)).toEqual([]);
  });
});

// @vitest-environment node
