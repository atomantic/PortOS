import { describe, it, expect } from 'vitest';
import {
  MINI_MAP_PADDING,
  computeBounds,
  computeDistrictBounds,
  projectPoint,
  computeMiniMap,
  geographyWorldPoints,
  projectGeography,
} from './cityMiniMap';
import { WORLD, PARCELS } from './cityPlan';

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

  it('keeps geography null for an empty city even when requested', () => {
    const vm = computeMiniMap([], new Map(), { geography: true });
    expect(vm.geography).toBeNull();
    expect(vm.empty).toBe(true);
  });

  it('folds the waterfront into the bounds when geography is enabled', () => {
    const apps = [{ id: 'a', overallStatus: 'online' }];
    const land = computeMiniMap(apps, positions([['a', 0, 0]]));
    const sea = computeMiniMap(apps, positions([['a', 0, 0]]), { geography: true });
    // The bay (z < shorelineZ, well north of a single downtown building) must push the
    // box's minZ above the shoreline so the water is on-frame.
    expect(sea.bounds.minZ).toBeLessThanOrEqual(WORLD.shorelineZ);
    expect(sea.bounds.minZ).toBeLessThan(land.bounds.minZ);
    expect(sea.geography).not.toBeNull();
    expect(sea.geography.harbor.label).toBe(PARCELS.dataHarbor.label);
  });

  it('projects the shoreline above the harbor marker (water reads north / top)', () => {
    const apps = [
      { id: 'a', overallStatus: 'online' },
      { id: 'b', overallStatus: 'online' },
    ];
    const vm = computeMiniMap(apps, positions([['a', -20, 20], ['b', 20, 40]]), { geography: true });
    const { shorelineY, harbor } = vm.geography;
    // The harbor sits out in the bay (z = -64, beyond the shoreline at z = -56), so it
    // projects above the shoreline line — a smaller ny (north reads as the top of the map).
    expect(harbor.ny).toBeLessThan(shorelineY);
    for (const v of [shorelineY, harbor.nx, harbor.ny]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('geographyWorldPoints', () => {
  it('returns shoreline + harbor anchors from the master plan', () => {
    const pts = geographyWorldPoints();
    expect(pts).toHaveLength(4);
    // Shoreline endpoints span the paved land width at the waterline.
    expect(pts[0]).toEqual({ x: -WORLD.landHalf, z: WORLD.shorelineZ });
    expect(pts[1]).toEqual({ x: WORLD.landHalf, z: WORLD.shorelineZ });
    // Harbor footprint corners straddle the parcel anchor out over the bay.
    const harbor = PARCELS.dataHarbor;
    expect(pts[2].z).toBeLessThan(WORLD.shorelineZ);
    expect(pts[3].x).toBeCloseTo(harbor.anchor[0] + harbor.w / 2);
  });
});

describe('projectGeography', () => {
  it('returns null when bounds are null', () => {
    expect(projectGeography(null)).toBeNull();
  });

  it('projects shoreline + harbor into normalized coordinates', () => {
    const bounds = { minX: -60, maxX: 60, minZ: -70, maxZ: 60 };
    const geo = projectGeography(bounds);
    expect(geo.shorelineY).toBeGreaterThanOrEqual(0);
    expect(geo.shorelineY).toBeLessThanOrEqual(1);
    expect(geo.harbor.label).toBe(PARCELS.dataHarbor.label);
    // Harbor anchor (z=-64) is north of the shoreline (z=-56) → projects higher (smaller ny).
    expect(geo.harbor.ny).toBeLessThan(geo.shorelineY);
  });
});
