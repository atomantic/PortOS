import { describe, it, expect } from 'vitest';
import { computeFocusCamera, BOROUGH_GROUND_RADIUS, CITY_CAMERA_FOV_DEG, computeRegionCamera, CITY_MAX_ORBIT_DISTANCE } from './cityFocusCamera';

const building = { x: 12, z: -24, height: 6 };

describe('computeFocusCamera', () => {
  it('targets the borough centre (up the tower) with no HUD offset', () => {
    const { target } = computeFocusCamera({ building, aspect: 1.6 });
    expect(target[0]).toBeCloseTo(building.x, 6);
    expect(target[2]).toBeCloseTo(building.z, 6);
    expect(target[1]).toBeGreaterThan(0);
    expect(target[1]).toBeLessThan(building.height);
  });

  it('places the camera above the tower and in front (+Z) so it never intersects geometry', () => {
    const { position } = computeFocusCamera({ building, aspect: 1.6 });
    expect(position[1]).toBeGreaterThan(building.height);
    expect(position[2]).toBeGreaterThan(building.z);
  });

  it('pulls the camera farther back for a portrait (narrow) aspect than a landscape one', () => {
    const portrait = computeFocusCamera({ building, aspect: 0.5 });
    const landscape = computeFocusCamera({ building, aspect: 2.0 });
    expect(portrait.distance).toBeGreaterThan(landscape.distance);
  });

  it('frames a taller tower from farther away', () => {
    const shortB = computeFocusCamera({ building: { x: 0, z: 0, height: 3 }, aspect: 1.6 });
    const tallB = computeFocusCamera({ building: { x: 0, z: 0, height: 40 }, aspect: 1.6 });
    expect(tallB.distance).toBeGreaterThan(shortB.distance);
    expect(tallB.radius).toBeGreaterThan(shortB.radius);
  });

  it('reserves headroom above the tower for the hologram / floating agents', () => {
    const { target, radius } = computeFocusCamera({ building, aspect: 1.6 });
    // The framed sphere reaches well above the tower top so agent markers are not clipped.
    expect(target[1] + radius).toBeGreaterThan(building.height + 3);
  });

  it('uses the borough ground radius floor for short buildings', () => {
    const { radius } = computeFocusCamera({ building: { x: 0, z: 0, height: 1 }, aspect: 1.6 });
    expect(radius).toBeGreaterThanOrEqual(BOROUGH_GROUND_RADIUS);
  });

  it('backs off and shifts the target when the HUD occupies the right edge', () => {
    // A portrait-ish aspect makes the horizontal extent the binding constraint, so shrinking the
    // usable width strictly increases the distance (in landscape a pan alone keeps it clear).
    const bare = computeFocusCamera({ building, aspect: 0.6 });
    const withPanel = computeFocusCamera({ building, aspect: 0.6, hudSafe: { right: 0.28 } });
    expect(withPanel.distance).toBeGreaterThan(bare.distance);
    // Target pans +x (borough shifts left, into the clear area beside the panel).
    expect(withPanel.target[0]).toBeGreaterThan(bare.target[0]);
    // Camera pans with the target so the view direction is preserved.
    expect(withPanel.position[0]).toBeCloseTo(withPanel.target[0], 6);
  });

  it('raises the framed region above a bottom-edge HUD panel', () => {
    const bare = computeFocusCamera({ building, aspect: 1.0 });
    const withSheet = computeFocusCamera({ building, aspect: 1.0, hudSafe: { bottom: 0.45 } });
    expect(withSheet.distance).toBeGreaterThan(bare.distance);
    // Panning up moves the target down in world space (building rises on screen).
    expect(withSheet.target[1]).toBeLessThan(bare.target[1]);
  });

  it('returns finite numbers for a missing/degenerate building', () => {
    const { position, target, distance } = computeFocusCamera({ building: undefined, aspect: 0 });
    [...position, ...target, distance].forEach((n) => expect(Number.isFinite(n)).toBe(true));
  });

  it('defaults to the city camera FOV', () => {
    const a = computeFocusCamera({ building, aspect: 1.6 });
    const b = computeFocusCamera({ building, aspect: 1.6, fovDeg: CITY_CAMERA_FOV_DEG });
    expect(a.distance).toBeCloseTo(b.distance, 6);
  });
});
// @vitest-environment node

describe('computeRegionCamera', () => {
  const region = { id: 'memory', anchor: [-44, 0, -30], w: 22, d: 22 };

  it('centers the shot on the parcel anchor', () => {
    const { target } = computeRegionCamera({ region, aspect: 16 / 9 });
    expect(target[0]).toBeCloseTo(region.anchor[0], 6);
    expect(target[2]).toBeCloseTo(region.anchor[2], 6);
  });

  it('sits above and on the +Z side of the region, like the overview camera', () => {
    const { position, target } = computeRegionCamera({ region, aspect: 16 / 9 });
    expect(position[1]).toBeGreaterThan(target[1]);
    expect(position[2]).toBeGreaterThan(region.anchor[2]);
  });

  it('backs off farther for a bigger parcel', () => {
    const small = computeRegionCamera({ region, aspect: 16 / 9 });
    const big = computeRegionCamera({ region: { ...region, w: 66, d: 40 }, aspect: 16 / 9 });
    expect(big.distance).toBeGreaterThan(small.distance);
  });

  it('floors the radius so a zero-footprint parcel still frames usefully', () => {
    const { distance, radius } = computeRegionCamera({ region: { anchor: [0, 0, 0], w: 0, d: 0 }, aspect: 1 });
    expect(radius).toBeGreaterThan(0);
    expect(Number.isFinite(distance)).toBe(true);
  });

  it('pans clear of the HUD safe area', () => {
    const bare = computeRegionCamera({ region, aspect: 16 / 9 });
    const withPanel = computeRegionCamera({ region, aspect: 16 / 9, hudSafe: { right: 0.28 } });
    expect(withPanel.target[0]).toBeGreaterThan(bare.target[0]);
  });

  it('survives a missing/degenerate region without producing NaNs', () => {
    for (const bad of [undefined, {}, { anchor: null }, { anchor: [NaN, 0, NaN], w: NaN, d: NaN }]) {
      const { position, target } = computeRegionCamera({ region: bad, aspect: 16 / 9 });
      for (const n of [...position, ...target]) expect(Number.isFinite(n)).toBe(true);
    }
  });
});

import { listRegions } from './openWorldRegions';

describe('framing stays inside the orbit-distance ceiling', () => {
  // CityScene hands CITY_MAX_ORBIT_DISTANCE straight to OrbitControls as maxDistance. A fly
  // that ended beyond it would be yanked back the instant the controls re-enabled, so the
  // framing math must never return a farther distance than the controls will keep.
  const VIEWPORTS = [
    ['desktop', 16 / 9, { right: 0.28, bottom: 0 }],
    ['narrow phone', 390 / 780, { right: 0, bottom: 0.5 }],
    ['degenerate', 0.2, { right: 0.9, bottom: 0.9 }],
  ];

  it('every real region frames within the ceiling on every viewport', () => {
    const over = [];
    for (const region of listRegions()) {
      for (const [name, aspect, hudSafe] of VIEWPORTS) {
        const { distance } = computeRegionCamera({ region, aspect, fovDeg: 50, hudSafe });
        if (distance > CITY_MAX_ORBIT_DISTANCE) over.push(`${region.id} @ ${name}: ${distance.toFixed(1)}`);
      }
    }
    expect(over).toEqual([]);
  });

  it('clamps rather than exceeding the ceiling for an absurdly large region', () => {
    const { distance } = computeRegionCamera({
      region: { anchor: [0, 0, 0], w: 5000, d: 5000 }, aspect: 0.4, fovDeg: 50,
    });
    expect(distance).toBe(CITY_MAX_ORBIT_DISTANCE);
  });

  it('clamps the borough focus camera too — they share the optics', () => {
    const { distance } = computeFocusCamera({
      building: { x: 0, z: 0, height: 100000 }, aspect: 0.4, fovDeg: 50,
    });
    expect(distance).toBe(CITY_MAX_ORBIT_DISTANCE);
  });
});

describe('computeRegionCamera — data-driven districts', () => {
  const parcel = { anchor: [0, 0, 0], w: 60, d: 60 };

  it('widens and re-centers on live layout bounds that outgrew the parcel', () => {
    const nominal = computeRegionCamera({ region: parcel, aspect: 16 / 9 });
    const grown = computeRegionCamera({
      region: parcel,
      bounds: { minX: -90, maxX: 90, minZ: -40, maxZ: 40 },
      aspect: 16 / 9,
    });
    expect(grown.radius).toBeGreaterThan(nominal.radius);
    // Re-centered on the live cloud, which here is symmetric about the parcel anchor.
    expect(grown.target[2]).toBeCloseTo(0, 6);
  });

  it('keeps the parcel as a floor so a near-empty install does not zoom into one tower', () => {
    const nominal = computeRegionCamera({ region: parcel, aspect: 16 / 9 });
    const tiny = computeRegionCamera({
      region: parcel,
      bounds: { minX: -6, maxX: 6, minZ: -6, maxZ: 6 },
      aspect: 16 / 9,
    });
    expect(tiny.radius).toBe(nominal.radius);
  });

  it('ignores partial or non-finite bounds rather than producing NaNs', () => {
    for (const bounds of [null, undefined, {}, { minX: 0, maxX: 10 }, { minX: NaN, maxX: 1, minZ: 0, maxZ: 1 }]) {
      const { position, target, radius } = computeRegionCamera({ region: parcel, bounds, aspect: 16 / 9 });
      for (const n of [...position, ...target, radius]) expect(Number.isFinite(n)).toBe(true);
      expect(radius).toBe(computeRegionCamera({ region: parcel, aspect: 16 / 9 }).radius);
    }
  });
});
