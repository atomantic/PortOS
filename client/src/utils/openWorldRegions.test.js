import { describe, it, expect } from 'vitest';
import {
  OPEN_WORLD_REGIONS,
  OPEN_WORLD_REGION_PREFIX,
  getRegion,
  listRegions,
  regionArrivalPoint,
  regionPath,
  searchRegions,
  REGION_ARRIVAL_SETBACK,
} from './openWorldRegions';
import { PARCELS, isWalkable } from './cityPlan';

describe('OPEN_WORLD_REGIONS registry', () => {
  it('has unique, URL-safe ids', () => {
    const ids = OPEN_WORLD_REGIONS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('every region names a parcel that exists in the master town plan', () => {
    const missing = OPEN_WORLD_REGIONS.filter((r) => !PARCELS[r.parcel]);
    expect(missing.map((r) => `${r.id}→${r.parcel}`)).toEqual([]);
  });

  it('every region carries a label and a blurb', () => {
    for (const region of OPEN_WORLD_REGIONS) {
      expect(region.label).toBeTruthy();
      expect(region.blurb).toBeTruthy();
    }
  });

  it('app paths are absolute PortOS routes (or an explicit null for set dressing)', () => {
    for (const region of OPEN_WORLD_REGIONS) {
      if (region.appPath === null) continue;
      expect(region.appPath).toMatch(/^\//);
    }
  });

  it('builds deep links under the region prefix', () => {
    expect(regionPath('memory')).toBe(`${OPEN_WORLD_REGION_PREFIX}/memory`);
  });
});

describe('getRegion', () => {
  it('resolves geography from the plan rather than re-declaring it', () => {
    const region = getRegion('memory');
    expect(region.anchor).toBe(PARCELS.memory.anchor);
    expect(region.w).toBe(PARCELS.memory.w);
    expect(region.d).toBe(PARCELS.memory.d);
    expect(region.planLabel).toBe(PARCELS.memory.label);
  });

  it('returns null for an absent or unknown id', () => {
    // This IS the route contract: /openworld/region/:regionId hands the raw param
    // straight to getRegion, and a null means "stay on the overview".
    expect(getRegion('atlantis')).toBeNull();
    expect(getRegion('')).toBeNull();
    expect(getRegion(undefined)).toBeNull();
    expect(getRegion(null)).toBeNull();
  });
});

describe('listRegions', () => {
  it('returns every region, geography resolved, in registry order', () => {
    const list = listRegions();
    expect(list).toHaveLength(OPEN_WORLD_REGIONS.length);
    expect(list.map((r) => r.id)).toEqual(OPEN_WORLD_REGIONS.map((r) => r.id));
    for (const region of list) expect(Array.isArray(region.anchor)).toBe(true);
  });
});

describe('searchRegions', () => {
  it('returns everything for an empty query', () => {
    expect(searchRegions('')).toHaveLength(OPEN_WORLD_REGIONS.length);
    expect(searchRegions('   ')).toHaveLength(OPEN_WORLD_REGIONS.length);
    expect(searchRegions(undefined)).toHaveLength(OPEN_WORLD_REGIONS.length);
  });

  it('matches labels case-insensitively', () => {
    expect(searchRegions('MEMORY').map((r) => r.id)).toContain('memory');
  });

  it('matches aliases the label does not contain', () => {
    // "jira yard" is an alias of the Sprint Yard — the label never says JIRA.
    expect(searchRegions('jira').map((r) => r.id)).toContain('sprint-yard');
  });

  it('preserves registry order so the list does not reshuffle as you type', () => {
    const order = OPEN_WORLD_REGIONS.map((r) => r.id);
    const hits = searchRegions('t').map((r) => r.id);
    expect(hits).toEqual(order.filter((id) => hits.includes(id)));
  });

  it('returns an empty list for a query nothing matches', () => {
    expect(searchRegions('zzzzz-nothing')).toEqual([]);
  });
});

describe('regionArrivalPoint', () => {
  it('lands on the near (+Z) edge of the parcel, set back so you can see it', () => {
    const region = getRegion('goals');
    const point = regionArrivalPoint(region);
    expect(point.x).toBe(PARCELS.goals.anchor[0]);
    expect(point.z).toBe(PARCELS.goals.anchor[2] + PARCELS.goals.d / 2 + REGION_ARRIVAL_SETBACK);
  });

  it('never drops a walking player into the bay', () => {
    for (const region of listRegions()) {
      const { x, z } = regionArrivalPoint(region);
      expect(isWalkable(x, z)).toBe(true);
    }
  });

  it('is null-safe', () => {
    expect(regionArrivalPoint(null)).toBeNull();
    expect(regionArrivalPoint(undefined)).toBeNull();
  });
});
