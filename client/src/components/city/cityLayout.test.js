import { describe, it, expect } from 'vitest';
import { computeCityLayout } from './cityLayout';

// spacing = BUILDING_PARAMS.spacing = 12, DISTRICT_PARAMS.gap = 4 (see cityConstants.js)
const online = (id) => ({ id, overallStatus: 'online', archived: false });

describe('computeCityLayout', () => {
  it('lays active apps in a square grid centered on the origin', () => {
    const pos = computeCityLayout([online('a'), online('b'), online('c'), online('d')]);
    // 4 apps → 2 cols, 2 rows; X & Z both centered at offset (2-1)*12/2 = 6
    expect(pos.get('a')).toMatchObject({ x: -6, z: -6, district: 'downtown' });
    expect(pos.get('b')).toMatchObject({ x: 6, z: -6, district: 'downtown' });
    expect(pos.get('c')).toMatchObject({ x: -6, z: 6, district: 'downtown' });
    expect(pos.get('d')).toMatchObject({ x: 6, z: 6, district: 'downtown' });
    // Each entry also carries a numeric building height (consumed by the
    // PlayerController proximity check); positions are no longer height-blind.
    expect(typeof pos.get('a').height).toBe('number');
    expect(pos.get('a').height).toBeGreaterThan(0);
  });

  it('places a single active app at the origin', () => {
    const pos = computeCityLayout([online('solo')]);
    expect(pos.get('solo')).toMatchObject({ x: 0, z: 0, district: 'downtown' });
  });

  it('offsets archived apps into a warehouse grid along +Z', () => {
    const pos = computeCityLayout([
      online('a'),
      { id: 'x', overallStatus: 'online', archived: true },
      { id: 'y', overallStatus: 'online', archived: true },
    ]);
    // 1 active → activeRows 1 → warehouseZ = 1*12/2 + 4 = 10; 2 archived → 2 cols, X offset 6
    expect(pos.get('a')).toMatchObject({ x: 0, z: 0, district: 'downtown' });
    expect(pos.get('x')).toMatchObject({ x: -6, z: 10, district: 'warehouse' });
    expect(pos.get('y')).toMatchObject({ x: 6, z: 10, district: 'warehouse' });
  });

  it('sorts active apps online-first so status drives grid order', () => {
    const pos = computeCityLayout([
      { id: 'stopped', overallStatus: 'stopped', archived: false },
      { id: 'live', overallStatus: 'online', archived: false },
    ]);
    // online sorts to index 0 (col 0), stopped to index 1 (col 1); 2 cols, 1 row, X offset 6
    expect(pos.get('live')).toMatchObject({ x: -6, z: 0, district: 'downtown' });
    expect(pos.get('stopped')).toMatchObject({ x: 6, z: 0, district: 'downtown' });
  });
});
