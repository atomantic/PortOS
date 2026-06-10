// Pure math for CyberCity's exploration-mode player rig: the third-person follow camera
// (spherical boom behind the character with building-aware shortening), frame-rate-
// independent damping, shortest-arc facing, and the avatar's animation-state classifier.
// PlayerController owns the THREE.Vector3 plumbing; every formula lives here on plain
// `{x, y, z}` objects so the whole rig is node-testable (no three.js / React imports).

// Convention (matches PlayerController): forward at yaw is (-sin(yaw), 0, -cos(yaw));
// the camera hangs BEHIND the character at (+sin(yaw), 0, +cos(yaw)) scaled by the boom.

// Shared rig dimensions — the controller, the avatar, and the boom collision all read
// these (restating them at call sites is how walk collision and camera collision drift).
export const EYE_HEIGHT = 1.6;
export const BUILDING_COLLISION_RADIUS = 3.5;

export const THIRD_PERSON = {
  boom: 6.5, // camera distance behind the character
  shoulder: 0.6, // lateral over-the-shoulder offset (positive = right)
  height: 2.4, // camera rise above the character's feet at pitch 0
  minPitch: -0.45, // looking up from under the character — floor-limited
  maxPitch: 1.15, // looking down over the character
  minCamY: 0.6, // the camera never dips into the pavement
  lookAhead: 2, // lookAt leads the character so the view reads forward
  lookHeight: 1.4, // aim at the chest, not the feet
  camDampRate: 8, // camera position smoothing (lower = floatier)
  lookDampRate: 12, // aim smoothing (tighter than position so aim stays crisp)
};

export const clampPitch = (pitch) =>
  Math.min(THIRD_PERSON.maxPitch, Math.max(THIRD_PERSON.minPitch, pitch));

// Desired third-person camera + aim point for a rig pose. Pure — collision is applied
// separately via resolveBoom so callers can damp toward the resolved point.
export function thirdPersonCamera({ pos, yaw, pitch, boom = THIRD_PERSON.boom }) {
  const p = clampPitch(pitch);
  const back = boom * Math.cos(p);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  // Right vector at this yaw (for the shoulder offset).
  const rightX = cosYaw;
  const rightZ = -sinYaw;
  return {
    camera: {
      x: pos.x + sinYaw * back + rightX * THIRD_PERSON.shoulder,
      y: Math.max(THIRD_PERSON.minCamY, pos.y + THIRD_PERSON.height + boom * Math.sin(p)),
      z: pos.z + cosYaw * back + rightZ * THIRD_PERSON.shoulder,
    },
    lookAt: {
      x: pos.x - sinYaw * THIRD_PERSON.lookAhead,
      y: pos.y + THIRD_PERSON.lookHeight,
      z: pos.z - cosYaw * THIRD_PERSON.lookAhead,
    },
  };
}

// True when a camera point lands inside a building cylinder (the same cylinder model
// PlayerController uses for walking collision). Above a building's roof the point is
// clear — flyover camera angles stay unclipped.
const insideBuilding = (point, building, radius) =>
  point.y < (building.height ?? 4) + 0.5
  && Math.hypot(point.x - building.x, point.z - building.z) < radius;

// Walk the camera in toward the aim anchor until it clears every building cylinder,
// returning `{ t, point }` — the boom fraction and the resolved camera position (so the
// caller never re-derives the lerp). "Collision-aware enough" — a sampled pull-in, not a
// raycast. `buildings` is an array or any iterable of { x, z, height }; pass a memoized
// array on hot paths (an iterable is re-collected per call).
export function resolveBoom({ anchor, camera, buildings, radius = BUILDING_COLLISION_RADIUS }) {
  const list = Array.isArray(buildings) ? buildings : buildings ? [...buildings] : [];
  const at = (t) => ({
    x: anchor.x + (camera.x - anchor.x) * t,
    y: anchor.y + (camera.y - anchor.y) * t,
    z: anchor.z + (camera.z - anchor.z) * t,
  });
  if (list.length === 0) return { t: 1, point: at(1) };
  const steps = [1, 0.85, 0.7, 0.55, 0.4, 0.3];
  for (const t of steps) {
    const point = at(t);
    if (!list.some((b) => insideBuilding(point, b, radius))) return { t, point };
  }
  return { t: 0.25, point: at(0.25) };
}

// Frame-rate-independent damping factor: lerp by this each frame and the closure rate
// stays constant whether the frame took 4ms or 40ms.
export const dampFactor = (rate, delta) => 1 - Math.exp(-rate * Math.max(0, delta));

// Shortest-arc angular lerp — never spins the long way around ±π.
export function dampAngle(current, target, factor) {
  let diff = (target - current) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * factor;
}

// The facing angle of the character for a local movement input: `forward` is +1 for W /
// -1 for S, `strafe` is +1 for D / -1 for A. The camera yaw stays mouse-driven; the
// character turns toward where it's actually going (strafe = quarter-turn run, S = run
// toward the camera).
export function moveFacing(yaw, { forward = 0, strafe = 0 }) {
  if (forward === 0 && strafe === 0) return yaw;
  // World-space movement direction.
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const dx = -sinYaw * forward + cosYaw * strafe;
  const dz = -cosYaw * forward - sinYaw * strafe;
  // Character forward is (-sin θ, -cos θ): solve θ so it aligns with (dx, dz).
  return Math.atan2(-dx, -dz);
}

// The avatar's animation state for the current rig pose.
export function avatarState({ moving = false, sprinting = false, airborne = false }) {
  if (airborne) return 'hover';
  if (!moving) return 'idle';
  return sprinting ? 'run' : 'walk';
}

// Banking target from yaw angular velocity (rad/s): lean into turns, clamped so the
// character never keels over. Callers damp toward this.
export function bankAngle(yawRate, max = 0.25, gain = 0.08) {
  return Math.min(max, Math.max(-max, -yawRate * gain));
}
