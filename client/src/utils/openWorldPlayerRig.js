// Pure math for OpenWorld's exploration-mode player rig: the third-person follow camera
// (spherical boom behind the character with building-aware shortening), frame-rate-
// independent damping, shortest-arc facing, and the avatar's animation-state classifier.
// PlayerController owns the THREE.Vector3 plumbing; every formula lives here on plain
// `{x, y, z}` objects so the whole rig is node-testable (no three.js / React imports).

// Convention (matches PlayerController): forward at yaw is (-sin(yaw), 0, -cos(yaw));
// the camera hangs BEHIND the character at (+sin(yaw), 0, +cos(yaw)) scaled by the boom.

// Shared rig dimensions — the controller, the avatar, and the boom collision all read
// these (restating them at call sites is how walk collision and camera collision drift).
export const EYE_HEIGHT = 1.6;
// Camera boom padding stays deliberately generous so the view does not clip into a
// facade. Player movement uses the shape-aware colliders below instead of this radius.
export const BUILDING_COLLISION_RADIUS = 3.5;
export const PLAYER_COLLISION_RADIUS = 0.55;
export const DEFAULT_SPAWN_Z = 52;

export const THIRD_PERSON = {
  boom: 16.5, // camera distance behind the character
  shoulder: 0.95, // lateral over-the-shoulder offset (positive = right)
  height: 3.6, // camera rise above the character's feet at pitch 0
  isometricYaw: Math.PI / 12, // slight diagonal framing keeps the downtown avenue in view
  isometricPitch: 0.62, // about 36° above the landscape, keeping landmarks in the frame
  fov: 42, // broader perspective gives the rover room to move through the landscape
  minPitch: -0.45, // looking up from under the character — floor-limited
  maxPitch: 1.15, // looking down over the character
  minCamY: 0.6, // the camera never dips into the pavement
  lookAhead: 2.4, // compose the rover against the road and landmarks ahead
  lookHeight: 0.85, // aim just above the rover so the landscape owns the frame
  camDampRate: 8, // camera position smoothing (lower = floatier)
  lookDampRate: 12, // aim smoothing (tighter than position so aim stays crisp)
};

// Arcade vehicle tuning for the default rover. It deliberately stops short of a full
// rigid-body simulation: OpenWorld needs a dependable, low-latency toy-car feel on a
// dashboard canvas, while still borrowing the important reference-game cues — ramped
// acceleration, a real brake, reverse, speed-weighted steering, and a little drift.
export const VEHICLE = {
  bodyLength: 1.85,
  bodyWidth: 1.06,
  maxSpeed: 24,
  boostMaxSpeed: 38,
  reverseMaxSpeed: 10,
  acceleration: 22,
  boostAcceleration: 31,
  coastDeceleration: 5.5,
  brakeDeceleration: 34,
  turnRate: 2.8,
  maxWheelAngle: 0.62,
  steeringResponse: 9,
};

// The visible wheels extend a little beyond the body box. Keep that small envelope in
// one place so the rover cannot visually overlap a wall without bringing back the old
// multi-unit empty cushion around every building.
export const VEHICLE_COLLISION = {
  halfWidth: 0.7,
  halfLength: 0.98,
};

export const clampPitch = (pitch) =>
  Math.min(THIRD_PERSON.maxPitch, Math.max(THIRD_PERSON.minPitch, pitch));

// Desired third-person camera + aim point for a rig pose. Pure — collision is applied
// separately via resolveBoom so callers can damp toward the resolved point.
export function thirdPersonCamera({
  pos,
  yaw,
  pitch,
  boom = THIRD_PERSON.boom,
  pitchOffset = 0,
}) {
  const p = clampPitch(pitch + pitchOffset);
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

// True when a camera point lands inside a building safety cylinder. The camera keeps a
// simpler generous envelope than the movement solver so the boom does not clip a facade.
const insideBuilding = (point, building, radius) =>
  point.y < (building.height ?? 4) + 0.5
  && Math.hypot(point.x - building.x, point.z - building.z) < radius;

// Walk the camera in toward the aim anchor until it clears every building safety cylinder,
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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const circleIntersectsBox = (point, collider, radius) => {
  const halfWidth = Math.max(0, collider.halfWidth ?? 0);
  const halfDepth = Math.max(0, collider.halfDepth ?? 0);
  const closestX = clamp(point.x, collider.x - halfWidth, collider.x + halfWidth);
  const closestZ = clamp(point.z, collider.z - halfDepth, collider.z + halfDepth);
  const dx = point.x - closestX;
  const dz = point.z - closestZ;
  return dx * dx + dz * dz < radius * radius;
};

const vehicleAxes = (heading) => ({
  right: { x: Math.cos(heading), z: -Math.sin(heading) },
  forward: { x: -Math.sin(heading), z: -Math.cos(heading) },
});

const vehicleIntersectsCircle = (point, collider, body) => {
  const { right, forward } = vehicleAxes(body.heading ?? 0);
  const dx = collider.x - point.x;
  const dz = collider.z - point.z;
  const localX = dx * right.x + dz * right.z;
  const localZ = dx * forward.x + dz * forward.z;
  const closestX = clamp(localX, -body.halfWidth, body.halfWidth);
  const closestZ = clamp(localZ, -body.halfLength, body.halfLength);
  const offsetX = localX - closestX;
  const offsetZ = localZ - closestZ;
  return offsetX * offsetX + offsetZ * offsetZ < (collider.radius ?? 0) ** 2;
};

const vehicleIntersectsBox = (point, collider, body) => {
  const { right, forward } = vehicleAxes(body.heading ?? 0);
  const axes = [
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    right,
    forward,
  ];
  const dx = collider.x - point.x;
  const dz = collider.z - point.z;
  const halfWidth = Math.max(0, collider.halfWidth ?? 0);
  const halfDepth = Math.max(0, collider.halfDepth ?? 0);

  return axes.every((axis) => {
    const distance = Math.abs(dx * axis.x + dz * axis.z);
    const vehicleProjection = Math.abs(axis.x * right.x + axis.z * right.z) * body.halfWidth
      + Math.abs(axis.x * forward.x + axis.z * forward.z) * body.halfLength;
    const colliderProjection = Math.abs(axis.x) * halfWidth + Math.abs(axis.z) * halfDepth;
    return distance < vehicleProjection + colliderProjection;
  });
};

const bodyIntersects = (point, colliders, body) => {
  const bodyType = body?.type || 'circle';
  if (bodyType === 'vehicle') {
    return colliders.some((collider) => {
      if (!Number.isFinite(collider?.x) || !Number.isFinite(collider?.z)) return false;
      return collider.shape === 'circle'
        ? vehicleIntersectsCircle(point, collider, body)
        : vehicleIntersectsBox(point, collider, body);
    });
  }

  const radius = Math.max(0, body?.radius ?? PLAYER_COLLISION_RADIUS);
  return colliders.some((collider) => {
    if (!Number.isFinite(collider?.x) || !Number.isFinite(collider?.z)) return false;
    if (collider.shape === 'circle') {
      const combinedRadius = radius + Math.max(0, collider.radius ?? 0);
      const dx = point.x - collider.x;
      const dz = point.z - collider.z;
      return dx * dx + dz * dz < combinedRadius * combinedRadius;
    }
    return circleIntersectsBox(point, collider, radius);
  });
};

// Move a player body through static 2D colliders. Each world axis is swept in small
// increments, then the first colliding increment is binary-searched to the contact
// point. Resolving X and Z independently gives the familiar arcade-game wall slide,
// while the sweep prevents a fast rover frame from tunneling through a pylon.
export function moveWithCollisions({
  position,
  displacement,
  colliders = [],
  body = { type: 'circle', radius: PLAYER_COLLISION_RADIUS },
  maxSampleDistance = 0.25,
}) {
  const current = { x: position?.x ?? 0, z: position?.z ?? 0 };
  const shapes = Array.isArray(colliders) ? colliders : [];
  const stepDistance = Math.max(0.01, Number.isFinite(maxSampleDistance) ? maxSampleDistance : 0.25);
  const blockedAxes = { x: false, z: false };
  let blocked = false;

  const moveAxis = (axis, amount) => {
    if (!Number.isFinite(amount) || amount === 0) return;
    const sampleCount = Math.max(1, Math.ceil(Math.abs(amount) / stepDistance));
    const sample = amount / sampleCount;

    for (let index = 0; index < sampleCount; index += 1) {
      const start = current[axis];
      const end = start + sample;
      const candidate = { x: current.x, z: current.z };
      candidate[axis] = end;
      if (!bodyIntersects(candidate, shapes, body)) {
        current[axis] = end;
        continue;
      }

      let safe = 0;
      let contact = 1;
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const midpoint = (safe + contact) * 0.5;
        const probe = { x: current.x, z: current.z };
        probe[axis] = start + sample * midpoint;
        if (bodyIntersects(probe, shapes, body)) contact = midpoint;
        else safe = midpoint;
      }
      current[axis] = start + sample * safe;
      blocked = true;
      blockedAxes[axis] = true;
      return;
    }
  };

  moveAxis('x', displacement?.x ?? 0);
  moveAxis('z', displacement?.z ?? 0);

  return { ...current, blocked, blockedAxes };
}

// Frame-rate-independent damping factor: lerp by this each frame and the closure rate
// stays constant whether the frame took 4ms or 40ms.
export const dampFactor = (rate, delta) => 1 - Math.exp(-rate * Math.max(0, delta));

const approach = (value, target, distance) => {
  if (value < target) return Math.min(target, value + distance);
  if (value > target) return Math.max(target, value - distance);
  return target;
};

// Advance the rover by one frame. Keeping this pure makes the handling tunable without
// tying the math to React or Three.js, and gives the controller one stable contract for
// keyboard, touch, and future gamepad inputs.
export function stepVehicle({
  speed = 0,
  heading = 0,
  wheelAngle = 0,
  throttle = 0,
  steer = 0,
  boost = false,
  brake = false,
  delta = 0.016,
}) {
  const dt = Math.min(0.05, Math.max(0, delta));
  const gas = Math.max(-1, Math.min(1, throttle));
  const steering = Math.max(-1, Math.min(1, steer));
  const targetLimit = gas < 0
    ? VEHICLE.reverseMaxSpeed
    : boost ? VEHICLE.boostMaxSpeed : VEHICLE.maxSpeed;
  const targetSpeed = brake ? 0 : gas * targetLimit;
  const changingDirection = speed !== 0 && targetSpeed !== 0 && Math.sign(speed) !== Math.sign(targetSpeed);
  const response = brake || changingDirection
    ? VEHICLE.brakeDeceleration
    : Math.abs(gas) > 0.01 ? (boost && gas > 0 ? VEHICLE.boostAcceleration : VEHICLE.acceleration) : VEHICLE.coastDeceleration;
  const nextSpeed = approach(speed, targetSpeed, response * dt);
  const targetWheelAngle = steering * VEHICLE.maxWheelAngle;
  const nextWheelAngle = wheelAngle + (targetWheelAngle - wheelAngle) * dampFactor(VEHICLE.steeringResponse, dt);
  const speedRatio = Math.min(1, Math.abs(nextSpeed) / VEHICLE.boostMaxSpeed);
  const reverseFactor = nextSpeed < -0.05 ? -1 : 1;
  const nextHeading = heading - nextWheelAngle * speedRatio * VEHICLE.turnRate * dt * reverseFactor;
  const forwardX = -Math.sin(nextHeading);
  const forwardZ = -Math.cos(nextHeading);

  return {
    speed: nextSpeed,
    heading: nextHeading,
    wheelAngle: nextWheelAngle,
    speedRatio,
    // `skid` is intentionally a visual signal, not a second physics state. It lets the
    // rover lean into a hard turn and gives the player feedback before a full tire-trail
    // system exists.
    skid: Math.min(1, Math.abs(nextWheelAngle / VEHICLE.maxWheelAngle) * speedRatio),
    displacement: {
      x: forwardX * nextSpeed * dt,
      z: forwardZ * nextSpeed * dt,
    },
  };
}

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
