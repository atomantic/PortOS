import { describe, it, expect } from 'vitest';
import {
  WORLD, PARCELS, PLAZA, TRANSIT, isInWater, computeStreets, computeStreetProps,
} from './cityPlan';

const staticParcels = Object.entries(PARCELS).filter(([, p]) => !p.dynamic);

describe('cityPlan PARCELS', () => {
  it('keeps every parcel inside the world bound', () => {
    for (const [id, p] of Object.entries(PARCELS)) {
      expect(Math.abs(p.anchor[0]) + p.w / 2, id).toBeLessThanOrEqual(WORLD.bound);
      expect(Math.abs(p.anchor[2]) + p.d / 2, id).toBeLessThanOrEqual(WORLD.bound);
    }
  });

  it('keeps land parcels on land and water parcels in the bay', () => {
    for (const [id, p] of staticParcels) {
      const nearEdge = p.anchor[2] - p.d / 2; // most-northern (bay-ward) edge
      if (p.water) {
        expect(isInWater(p.anchor[0], p.anchor[2]), id).toBe(true);
      } else {
        expect(nearEdge, id).toBeGreaterThan(WORLD.shorelineZ);
      }
    }
  });

  it('keeps static parcels (except the plaza itself) clear of the AI Core plaza', () => {
    for (const [id, p] of staticParcels) {
      if (id === 'aiCore') continue;
      const dist = Math.hypot(p.anchor[0], p.anchor[2]);
      expect(dist - Math.max(p.w, p.d) / 2, id).toBeGreaterThanOrEqual(PLAZA.radius - 0.01);
    }
  });

  it('keeps the new harbor parcel clear of every land parcel', () => {
    const harbor = PARCELS.dataHarbor;
    for (const [id, p] of staticParcels) {
      if (id === 'dataHarbor') continue;
      const xOverlap = Math.abs(harbor.anchor[0] - p.anchor[0]) < (harbor.w + p.w) / 2;
      const zOverlap = Math.abs(harbor.anchor[2] - p.anchor[2]) < (harbor.d + p.d) / 2;
      expect(xOverlap && zOverlap, `dataHarbor vs ${id}`).toBe(false);
    }
  });

  it('every parcel carries an anchor, footprint, and label', () => {
    for (const [id, p] of Object.entries(PARCELS)) {
      expect(p.anchor, id).toHaveLength(3);
      expect(p.w, id).toBeGreaterThan(0);
      expect(p.d, id).toBeGreaterThan(0);
      expect(typeof p.label, id).toBe('string');
    }
  });
});

describe('isInWater', () => {
  it('classifies the bay vs land around the shoreline', () => {
    expect(isInWater(0, WORLD.shorelineZ - 1)).toBe(true);
    expect(isInWater(0, WORLD.shorelineZ + 1)).toBe(false);
    expect(isInWater(0, 0)).toBe(false);
  });

  it('margin extends the water zone toward land', () => {
    expect(isInWater(0, WORLD.shorelineZ + 2, 4)).toBe(true);
    expect(isInWater(0, WORLD.shorelineZ + 6, 4)).toBe(false);
  });
});

describe('TRANSIT', () => {
  it('keeps the loop track on land, above the streets, below rooftop scale', () => {
    expect(TRANSIT.y).toBeGreaterThan(6);
    expect(TRANSIT.y).toBeLessThan(14);
    for (const stop of TRANSIT.stops) {
      expect(stop.point[1], stop.id).toBe(TRANSIT.y);
      expect(isInWater(stop.point[0], stop.point[2]), stop.id).toBe(false);
      expect(Math.abs(stop.point[0]), stop.id).toBeLessThanOrEqual(WORLD.bound);
      expect(Math.abs(stop.point[2]), stop.id).toBeLessThanOrEqual(WORLD.bound);
    }
  });

  it('has unique stop ids', () => {
    const ids = TRANSIT.stops.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('derives district stops from their parcel anchors — moving a parcel moves its stop', () => {
    for (const stop of TRANSIT.stops) {
      const parcel = PARCELS[stop.id];
      if (!parcel) continue; // harborGate / warehouse promenade are explicit
      expect(stop.point[0], stop.id).toBeCloseTo(parcel.anchor[0] * (1 - TRANSIT.stopPull), 6);
      expect(stop.point[2], stop.id).toBeCloseTo(parcel.anchor[2] * (1 - TRANSIT.stopPull), 6);
    }
    // The loop serves most quarters: at least 7 stops are parcel-derived.
    expect(TRANSIT.stops.filter((s) => PARCELS[s.id]).length).toBeGreaterThanOrEqual(7);
  });
});

describe('computeStreets', () => {
  const streets = computeStreets();

  it('is deterministic', () => {
    expect(computeStreets()).toEqual(streets);
  });

  it('builds a closed 8-segment ring road', () => {
    const ring = streets.segments.filter((s) => s.kind === 'ring');
    expect(ring).toHaveLength(8);
    for (const seg of ring) {
      // Every ring segment's center sits on the ring radius (chord midpoint, slightly inside).
      expect(Math.hypot(seg.x, seg.z)).toBeGreaterThan(20);
      expect(Math.hypot(seg.x, seg.z)).toBeLessThan(31);
    }
  });

  it('runs a spoke toward every outlying served district', () => {
    const spokeTargets = streets.segments.filter((s) => s.kind === 'spoke').map((s) => s.to);
    for (const id of ['memory', 'jira', 'goals', 'artifacts', 'productivity', 'health', 'easterEggs']) {
      expect(spokeTargets, id).toContain(id);
    }
    // Each spoke ends short of its district anchor (clearance) and starts at the ring.
    for (const seg of streets.segments.filter((s) => s.kind === 'spoke')) {
      const [ax, , az] = PARCELS[seg.to].anchor;
      const anchorDist = Math.hypot(ax, az);
      const segFar = Math.hypot(seg.x, seg.z) + seg.length / 2;
      expect(segFar, seg.to).toBeLessThan(anchorDist);
    }
  });

  it('runs the avenue from the plaza to the shoreline without entering the water', () => {
    const avenue = streets.segments.find((s) => s.kind === 'avenue');
    expect(avenue).toBeTruthy();
    expect(avenue.x).toBe(0);
    const farEdge = avenue.z - avenue.length / 2;
    expect(farEdge).toBeGreaterThanOrEqual(WORLD.shorelineZ);
  });

  it('keeps every street on land', () => {
    for (const seg of streets.segments) {
      const cos = Math.cos(seg.angle);
      const sin = Math.sin(seg.angle);
      for (const t of [-0.5, 0, 0.5]) {
        const z = seg.z + sin * t * seg.length;
        expect(isInWater(seg.x + cos * t * seg.length, z), seg.kind).toBe(false);
      }
    }
  });

  it('places a crosswalk where each spoke meets the ring', () => {
    const spokes = streets.segments.filter((s) => s.kind === 'spoke');
    expect(streets.crosswalks).toHaveLength(spokes.length);
  });
});

describe('computeStreetProps', () => {
  const streets = computeStreets();

  it('is deterministic and density-scaled', () => {
    const full = computeStreetProps(streets, 1);
    expect(computeStreetProps(streets, 1)).toEqual(full);
    const half = computeStreetProps(streets, 0.5);
    expect(half.lamps.length).toBeLessThan(full.lamps.length);
    expect(half.lamps.length).toBeGreaterThan(0);
  });

  it('returns no props at zero density or missing streets', () => {
    expect(computeStreetProps(streets, 0)).toEqual({ lamps: [], trees: [] });
    expect(computeStreetProps(null, 1)).toEqual({ lamps: [], trees: [] });
  });

  it('keeps lamps on land and inside the world bound', () => {
    const { lamps } = computeStreetProps(streets, 1.5);
    expect(lamps.length).toBeGreaterThan(10);
    for (const lamp of lamps) {
      expect(isInWater(lamp.x, lamp.z)).toBe(false);
      expect(Math.abs(lamp.x)).toBeLessThanOrEqual(WORLD.bound);
      expect(Math.abs(lamp.z)).toBeLessThanOrEqual(WORLD.bound);
    }
  });

  it('rings the plaza with trees but leaves the avenue mouth open', () => {
    const { trees } = computeStreetProps(streets, 1);
    expect(trees.length).toBeGreaterThan(5);
    for (const tree of trees) {
      const r = Math.hypot(tree.x, tree.z);
      expect(r).toBeGreaterThan(PLAZA.radius);
      // No tree blocks the avenue (north sector around x=0, z negative).
      const onAvenue = Math.abs(tree.x) < 3 && tree.z < -PLAZA.radius * 0.8;
      expect(onAvenue).toBe(false);
    }
  });
});
