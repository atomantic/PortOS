import { describe, it, expect } from 'vitest';
import { computeFocusCamera, BOROUGH_GROUND_RADIUS, CITY_CAMERA_FOV_DEG } from './cityFocusCamera';

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
