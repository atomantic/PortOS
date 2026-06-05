import { describe, it, expect } from 'vitest';
import { computeCityLayout } from './cityLayout';

// spacing = BUILDING_PARAMS.spacing = 12, DISTRICT_PARAMS.gap = 4 (see cityConstants.js)
const online = (id) => ({ id, overallStatus: 'online', archived: false });

describe('computeCityLayout', () => {
  it('lays active apps around a reserved AI Core plaza', () => {
    const pos = computeCityLayout([online('a'), online('b'), online('c'), online('d')]);
    // 4 apps → 2 cols, 2 rows at ±6; each cell falls inside the 12-unit core plaza,
    // so clearCorePlaza pushes it radially out to the plaza edge (12/√2 ≈ 8.4853).
    expect(pos.get('a').district).toBe('downtown');
    expect(pos.get('a').x).toBeCloseTo(-8.485281);
    expect(pos.get('a').z).toBeCloseTo(-8.485281);
    expect(pos.get('b').x).toBeCloseTo(8.485281);
    expect(pos.get('b').z).toBeCloseTo(-8.485281);
    expect(pos.get('c').x).toBeCloseTo(-8.485281);
    expect(pos.get('c').z).toBeCloseTo(8.485281);
    expect(pos.get('d').x).toBeCloseTo(8.485281);
    expect(pos.get('d').z).toBeCloseTo(8.485281);
    // Plaza clearance only rewrites x/z — each entry still carries a numeric building
    // height (consumed by the PlayerController proximity check).
    expect(typeof pos.get('a').height).toBe('number');
    expect(pos.get('a').height).toBeGreaterThan(0);
  });

  it('pushes a lone centered app to the front edge of the core plaza', () => {
    const pos = computeCityLayout([online('solo')]);
    // A single app grids to the origin, which has no push direction → front (-Z) edge.
    expect(pos.get('solo')).toMatchObject({ x: 0, z: -12, district: 'downtown' });
    expect(typeof pos.get('solo').height).toBe('number');
  });

  it('offsets archived apps into a warehouse grid clear of the core plaza on sparse installs', () => {
    const pos = computeCityLayout([
      online('a'),
      { id: 'x', overallStatus: 'online', archived: true },
      { id: 'y', overallStatus: 'online', archived: true },
    ]);
    // 1 active → raw warehouseZ = 1*12/2 + 4 = 10, which sits inside the 12-unit core
    // plaza — so the floor lifts it to CORE_CLEARANCE_RADIUS + gap = 16. 2 archived → 2
    // cols, X offset 6. The active app clears to the plaza front edge.
    expect(pos.get('a')).toMatchObject({ x: 0, z: -12, district: 'downtown' });
    expect(pos.get('x')).toMatchObject({ x: -6, z: 16, district: 'warehouse' });
    expect(pos.get('y')).toMatchObject({ x: 6, z: 16, district: 'warehouse' });
  });

  it('keeps the warehouse off the core on an all-archived install (no active apps)', () => {
    const pos = computeCityLayout([
      { id: 'x', overallStatus: 'online', archived: true },
      { id: 'y', overallStatus: 'online', archived: true },
    ]);
    // No active apps → raw warehouseZ = 0*12/2 + 4 = 4, which would drop the near row
    // (and the ARCHIVE DISTRICT label at z-2) on top of the AI Core. The floor lifts the
    // near row to 16 so the label lands at z=14, clear of the 12-unit core plaza.
    expect(pos.get('x')).toMatchObject({ x: -6, z: 16, district: 'warehouse' });
    expect(pos.get('y')).toMatchObject({ x: 6, z: 16, district: 'warehouse' });
  });

  it('leaves the warehouse offset untouched for normal installs (3+ active apps)', () => {
    const pos = computeCityLayout([
      online('a'), online('b'), online('c'),
      { id: 'x', overallStatus: 'online', archived: true },
    ]);
    // 3 active → activeRows 2 → raw warehouseZ = 2*12/2 + 4 = 16, already at the floor,
    // so max(16, 16) is a no-op: established layouts for normal installs don't shift.
    expect(pos.get('x')).toMatchObject({ x: 0, z: 16, district: 'warehouse' });
  });

  it('never stacks two downtown buildings when clearing the core plaza', () => {
    // 9 apps → 3×3 grid: the centre cell sits on the core and must move, but the
    // front-edge slot is already taken, so it must dodge to a free ring slot rather
    // than stack. Assert every resolved position is unique.
    const pos = computeCityLayout(Array.from({ length: 9 }, (_, i) => online(String(i))));
    const seen = new Set();
    for (const p of pos.values()) {
      const key = `${Math.round(p.x)},${Math.round(p.z)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(9);
  });

  it('sorts active apps online-first so status drives grid order', () => {
    const pos = computeCityLayout([
      { id: 'stopped', overallStatus: 'stopped', archived: false },
      { id: 'live', overallStatus: 'online', archived: false },
    ]);
    // online sorts to index 0 (col 0), stopped to index 1 (col 1) at ±6; clearCorePlaza
    // then pushes both out along ±X to the 12-unit plaza edge.
    expect(pos.get('live')).toMatchObject({ x: -12, z: 0, district: 'downtown' });
    expect(pos.get('stopped')).toMatchObject({ x: 12, z: 0, district: 'downtown' });
  });
});
