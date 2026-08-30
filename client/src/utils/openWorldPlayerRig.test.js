import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPAWN_Z, THIRD_PERSON, BOOM_ZOOM, clampPitch, thirdPersonCamera, nextBoomZoom, resolveBoom,
  dampFactor, dampAngle, moveFacing, avatarState, bankAngle, stepVehicle,
  moveWithCollisions, solveKabschTransform, solveVehicleSuspensionPose, VEHICLE_COLLISION,
} from './openWorldPlayerRig';
import { isWalkable } from './openWorldPlan';

const pos = { x: 0, y: 1.6, z: 0 };

describe('authored arrival', () => {
  it('starts the rover on The Port rather than deriving spawn from app layout', () => {
    expect(DEFAULT_SPAWN_Z).toBeGreaterThan(0);
    expect(DEFAULT_SPAWN_Z).toBeGreaterThan(40);
    expect(DEFAULT_SPAWN_Z).toBeLessThan(55);
    expect(isWalkable(0, DEFAULT_SPAWN_Z)).toBe(true);
  });
});

describe('terrain suspension', () => {
  it('preserves an identity point cloud with no residual', () => {
    const points = [
      { x: -1, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
      { x: -1, y: 0, z: -1 },
      { x: 1, y: 0, z: -1 },
    ];
    const pose = solveKabschTransform(points, points);
    expect(pose.rotation.w).toBeCloseTo(1, 6);
    expect(pose.rotation.x).toBeCloseTo(0, 6);
    expect(pose.rotation.z).toBeCloseTo(0, 6);
    expect(pose.residual).toBeCloseTo(0, 6);
  });

  it('fits the chassis to four independently sampled wheel contacts', () => {
    const pose = solveVehicleSuspensionPose({
      x: 4,
      z: -7,
      heading: 0.4,
      centerHeight: 0,
      halfWidth: 0.8,
      halfLength: 1.1,
      heightAt: (x, z) => x * 0.1 + z * 0.06,
    });
    expect(new Set(pose.wheelOffsets.map((value) => value.toFixed(4))).size).toBeGreaterThan(2);
    expect(Math.hypot(pose.rotation.x, pose.rotation.z)).toBeGreaterThan(0.02);
    expect(Math.hypot(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w)).toBeCloseTo(1, 6);
    expect(pose.residual).toBeLessThan(0.02);
  });

  it('uses only the small fit residual for per-wheel travel on a planar slope', () => {
    const pose = solveVehicleSuspensionPose({
      x: 0,
      z: 0,
      heading: 0,
      centerHeight: 0,
      halfWidth: 0.8,
      halfLength: 1.1,
      heightAt: (_x, z) => z * 0.25,
    });

    expect(Math.max(...pose.wheelOffsets.map(Math.abs))).toBeGreaterThan(0.2);
    expect(Math.max(...pose.wheelTravel.map(Math.abs))).toBeLessThan(0.01);
  });
});

describe('nextBoomZoom', () => {
  it('zooms in for an upward wheel scroll and out for a downward one', () => {
    const zoomIn = nextBoomZoom(1, -120);
    const zoomOut = nextBoomZoom(1, 120);
    expect(zoomIn).toBeLessThan(1);
    expect(zoomOut).toBeGreaterThan(1);
  });

  it('is symmetric per notch — equal deltas move the multiplier equally in log space', () => {
    const zoomIn = nextBoomZoom(1, -120);
    const zoomOut = nextBoomZoom(1, 120);
    expect(Math.log(zoomIn)).toBeCloseTo(-Math.log(zoomOut), 6);
  });

  it('clamps both ends so the boom never vanishes nor leaves the world scale', () => {
    expect(nextBoomZoom(1, -1e9)).toBe(BOOM_ZOOM.min);
    expect(nextBoomZoom(1, 1e9)).toBe(BOOM_ZOOM.max);
  });

  it('feeds thirdPersonCamera as a boom multiplier', () => {
    const base = thirdPersonCamera({ pos, yaw: 0, pitch: 0 });
    const close = thirdPersonCamera({ pos, yaw: 0, pitch: 0, boom: THIRD_PERSON.boom * BOOM_ZOOM.min });
    expect(Math.abs(close.camera.z - pos.z)).toBeLessThan(Math.abs(base.camera.z - pos.z));
  });
});

describe('thirdPersonCamera', () => {
  it('hangs the camera behind the character at yaw 0 (facing -Z → camera at +Z)', () => {
    const { camera, lookAt } = thirdPersonCamera({ pos, yaw: 0, pitch: 0 });
    expect(camera.z).toBeGreaterThan(pos.z + THIRD_PERSON.boom * 0.9);
    expect(camera.x).toBeCloseTo(THIRD_PERSON.shoulder, 5); // right vector at yaw 0 is +X
    expect(camera.y).toBeCloseTo(pos.y + THIRD_PERSON.height, 5);
    // Aim leads the character forward (-Z) at chest height.
    expect(lookAt.z).toBeCloseTo(-THIRD_PERSON.lookAhead, 5);
    expect(lookAt.y).toBeCloseTo(pos.y + THIRD_PERSON.lookHeight, 5);
  });

  it('tracks yaw — at yaw π/2 (facing -X) the camera sits at +X', () => {
    const { camera } = thirdPersonCamera({ pos, yaw: Math.PI / 2, pitch: 0 });
    expect(camera.x).toBeGreaterThan(THIRD_PERSON.boom * 0.9);
    expect(Math.abs(camera.z)).toBeLessThan(1.5); // just the shoulder offset
  });

  it('raises the camera with positive pitch and clamps both ends', () => {
    const level = thirdPersonCamera({ pos, yaw: 0, pitch: 0 });
    const high = thirdPersonCamera({ pos, yaw: 0, pitch: 0.8 });
    expect(high.camera.y).toBeGreaterThan(level.camera.y);
    // Clamped: an absurd pitch matches the clamp boundary exactly.
    const over = thirdPersonCamera({ pos, yaw: 0, pitch: 9 });
    const atMax = thirdPersonCamera({ pos, yaw: 0, pitch: THIRD_PERSON.maxPitch });
    expect(over.camera.y).toBeCloseTo(atMax.camera.y, 6);
    expect(clampPitch(-9)).toBe(THIRD_PERSON.minPitch);
  });

  it('supports a separate isometric tilt without changing the rig pitch', () => {
    const level = thirdPersonCamera({ pos, yaw: 0, pitch: 0 });
    const tilted = thirdPersonCamera({
      pos,
      yaw: 0,
      pitch: 0,
      pitchOffset: THIRD_PERSON.isometricPitch,
    });
    expect(tilted.camera.y).toBeGreaterThan(level.camera.y);
    expect(tilted.camera.z).toBeLessThan(level.camera.z);
  });

  it('never dips the camera into the pavement', () => {
    const { camera } = thirdPersonCamera({ pos: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: -0.45 });
    expect(camera.y).toBeGreaterThanOrEqual(THIRD_PERSON.minCamY);
  });
});

describe('resolveBoom', () => {
  const anchor = { x: 0, y: 2, z: 0 };

  it('keeps the full boom with no obstructions', () => {
    const clear = resolveBoom({ anchor, camera: { x: 0, y: 3, z: 7 }, buildings: [] });
    expect(clear.t).toBe(1);
    expect(clear.point).toEqual({ x: 0, y: 3, z: 7 });
    expect(resolveBoom({ anchor, camera: { x: 0, y: 3, z: 7 }, buildings: null }).t).toBe(1);
  });

  it('shortens the boom when the camera lands inside a building cylinder', () => {
    const buildings = [{ x: 0, z: 7, height: 10 }];
    const { t, point } = resolveBoom({ anchor, camera: { x: 0, y: 3, z: 7 }, buildings });
    expect(t).toBeLessThan(1);
    // The resolved point actually clears the cylinder.
    expect(Math.abs(point.z - 7)).toBeGreaterThanOrEqual(3.5);
  });

  it('ignores buildings the camera clears above (flyover)', () => {
    const buildings = [{ x: 0, z: 7, height: 4 }];
    expect(resolveBoom({ anchor, camera: { x: 0, y: 12, z: 7 }, buildings }).t).toBe(1);
  });

  it('accepts any iterable (e.g. Map.values())', () => {
    const map = new Map([['a', { x: 0, z: 7, height: 10 }]]);
    const { t } = resolveBoom({ anchor, camera: { x: 0, y: 3, z: 7 }, buildings: map.values() });
    expect(t).toBeLessThan(1);
  });
});

describe('moveWithCollisions', () => {
  const box = { shape: 'box', x: 0, z: 0, halfWidth: 1, halfDepth: 1 };

  it('stops at a box facade instead of using a large center radius', () => {
    const result = moveWithCollisions({
      position: { x: -4, z: 0 },
      displacement: { x: 4, z: 0 },
      colliders: [box],
      body: { type: 'circle', radius: 0.5 },
    });

    expect(result.blocked).toBe(true);
    expect(result.x).toBeCloseTo(-1.5, 2);
    expect(result.z).toBe(0);
    expect(Number.isFinite(result.x)).toBe(true);
  });

  it('slides along a wall while preserving movement on the open axis', () => {
    const result = moveWithCollisions({
      position: { x: -3, z: 0 },
      displacement: { x: 3, z: 0.8 },
      colliders: [box],
      body: { type: 'circle', radius: 0.5 },
    });

    expect(result.blockedAxes.x).toBe(true);
    expect(result.blockedAxes.z).toBe(false);
    expect(result.x).toBeCloseTo(-1.5, 2);
    expect(result.z).toBeCloseTo(0.8, 2);
  });

  it('uses the rover footprint and heading for box contact', () => {
    const result = moveWithCollisions({
      position: { x: -4, z: 0 },
      displacement: { x: 4, z: 0 },
      colliders: [box],
      body: { type: 'vehicle', heading: 0, ...VEHICLE_COLLISION },
    });

    expect(result.blocked).toBe(true);
    expect(result.x).toBeCloseTo(-1 - VEHICLE_COLLISION.halfWidth, 2);
  });

  it('treats round process pylons as their actual small footprint', () => {
    const result = moveWithCollisions({
      position: { x: -3, z: 0 },
      displacement: { x: 3, z: 0 },
      colliders: [{ shape: 'circle', x: 0, z: 0, radius: 0.46 }],
      body: { type: 'circle', radius: 0.5 },
    });

    expect(result.blocked).toBe(true);
    expect(result.x).toBeCloseTo(-0.96, 2);
  });
});

describe('dampFactor', () => {
  it('is monotonic in delta and bounded to [0, 1)', () => {
    const a = dampFactor(8, 0.004);
    const b = dampFactor(8, 0.016);
    const c = dampFactor(8, 0.1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(1);
    expect(dampFactor(8, 0)).toBe(0);
    expect(dampFactor(8, -1)).toBe(0); // negative delta can't overshoot backward
  });

  it('two small steps ≈ one big step (frame-rate independence)', () => {
    const one = dampFactor(8, 0.032);
    const half = dampFactor(8, 0.016);
    const twoStep = half + (1 - half) * half;
    expect(twoStep).toBeCloseTo(one, 6);
  });
});

describe('dampAngle', () => {
  it('moves toward the target', () => {
    expect(dampAngle(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('takes the shortest arc across ±π', () => {
    // From just below π to just above -π is a tiny step, not a full spin.
    const next = dampAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
    expect(next).toBeGreaterThan(Math.PI - 0.1); // continues past π, not backward
    expect(next - (Math.PI - 0.1)).toBeCloseTo(0.1, 5);
  });
});

describe('stepVehicle', () => {
  it('ramps speed instead of teleporting to the target velocity', () => {
    const first = stepVehicle({ throttle: 1, delta: 0.016 });
    expect(first.speed).toBeGreaterThan(0);
    expect(first.speed).toBeLessThan(24);
    expect(first.displacement.z).toBeLessThan(0);
  });

  it('coasts down and brakes faster', () => {
    const coasting = stepVehicle({ speed: 12, delta: 0.016 });
    const braking = stepVehicle({ speed: 12, throttle: 1, brake: true, delta: 0.016 });
    expect(coasting.speed).toBeLessThan(12);
    expect(braking.speed).toBeLessThan(coasting.speed);
  });

  it('steers more as speed builds and reverses the turn in reverse', () => {
    const forward = stepVehicle({ speed: 18, heading: 0, steer: 1, delta: 0.016 });
    const reverse = stepVehicle({ speed: -8, heading: 0, steer: 1, delta: 0.016 });
    expect(forward.heading).toBeLessThan(0);
    expect(reverse.heading).toBeGreaterThan(0);
    expect(forward.wheelAngle).toBeGreaterThan(0);
  });
});

describe('moveFacing', () => {
  it('faces the camera yaw when moving forward', () => {
    expect(moveFacing(0.3, { forward: 1, strafe: 0 })).toBeCloseTo(0.3, 6);
  });

  it('quarter-turns for a pure strafe', () => {
    const right = moveFacing(0, { forward: 0, strafe: 1 });
    // Strafing right at yaw 0 moves along +X; the character faces +X → θ = -π/2.
    expect(right).toBeCloseTo(-Math.PI / 2, 6);
    const left = moveFacing(0, { forward: 0, strafe: -1 });
    expect(left).toBeCloseTo(Math.PI / 2, 6);
  });

  it('faces the camera when backpedaling', () => {
    const back = moveFacing(0, { forward: -1, strafe: 0 });
    expect(Math.abs(back)).toBeCloseTo(Math.PI, 6);
  });

  it('keeps the current yaw with no input', () => {
    expect(moveFacing(0.7, { forward: 0, strafe: 0 })).toBe(0.7);
  });
});

describe('avatarState', () => {
  it('classifies the four states with airborne taking priority', () => {
    expect(avatarState({ moving: false })).toBe('idle');
    expect(avatarState({ moving: true })).toBe('walk');
    expect(avatarState({ moving: true, sprinting: true })).toBe('run');
    expect(avatarState({ moving: true, sprinting: true, airborne: true })).toBe('hover');
  });
});

describe('bankAngle', () => {
  it('leans opposite the yaw rate and clamps', () => {
    expect(bankAngle(1)).toBeLessThan(0);
    expect(bankAngle(-1)).toBeGreaterThan(0);
    expect(bankAngle(100)).toBe(-0.25);
    expect(bankAngle(-100)).toBe(0.25);
    expect(bankAngle(0)).toBeCloseTo(0, 10);
  });
});
// @vitest-environment node
