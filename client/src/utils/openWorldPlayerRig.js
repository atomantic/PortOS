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
export const DEFAULT_SPAWN_Z = 48;

export const THIRD_PERSON = {
  boom: 10.5, // intimate chase framing: the rover is a character, not a map cursor
  shoulder: 0.72, // slight lateral offset keeps the next cottage visible past the cab
  height: 3.1, // low enough for fences and trees to create useful occlusion
  isometricYaw: Math.PI / 18, // nearly aligned with the arrival lane and village gate
  isometricPitch: 0.36, // cozy diorama angle without flattening the street into a map
  fov: 42, // restrained perspective keeps nearby props substantial
  minPitch: -0.45, // looking up from under the character — floor-limited
  maxPitch: 1.15, // looking down over the character
  minCamY: 0.6, // the camera never dips into the pavement
  lookAhead: 3.2, // compose the rover against the next bend and doorway
  lookHeight: 1.05, // aim just over the roof so village silhouettes fill the frame
  camDampRate: 10, // close camera needs a little less float through tight paths
  lookDampRate: 14, // aim smoothing stays tighter than position
};

// Scroll-wheel boom zoom: a multiplier over THIRD_PERSON.boom. Steps are multiplicative
// (exp of the wheel delta) so each notch feels equally sized at both ends of the range,
// the way pinch-zoom does.
export const BOOM_ZOOM = {
  min: 0.45,
  max: 2.1,
  wheelRate: 0.0011, // exp factor per unit of WheelEvent.deltaY
};

export const nextBoomZoom = (current, deltaY) =>
  Math.min(BOOM_ZOOM.max, Math.max(BOOM_ZOOM.min, current * Math.exp(deltaY * BOOM_ZOOM.wheelRate)));

// Arcade vehicle tuning for the default rover. It deliberately stops short of a full
// rigid-body simulation: OpenWorld needs a dependable, low-latency toy-car feel on a
// dashboard canvas, while still borrowing the important reference-game cues — ramped
// acceleration, a real brake, reverse, speed-weighted steering, and a little drift.
export const VEHICLE = {
  bodyLength: 2.5,
  bodyWidth: 1.46,
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
  halfWidth: 0.92,
  halfLength: 1.36,
};

const centroid = (points) => {
  const total = points.reduce((sum, point) => ({
    x: sum.x + point.x,
    y: sum.y + point.y,
    z: sum.z + point.z,
  }), { x: 0, y: 0, z: 0 });
  const count = Math.max(1, points.length);
  return { x: total.x / count, y: total.y / count, z: total.z / count };
};

const rotateByQuaternion = (point, quaternion) => {
  const { x, y, z, w } = quaternion;
  const ix = w * point.x + y * point.z - z * point.y;
  const iy = w * point.y + z * point.x - x * point.z;
  const iz = w * point.z + x * point.y - y * point.x;
  const iw = -x * point.x - y * point.y - z * point.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
};

// Horn's quaternion form of the Kabsch fit. Given matching point clouds, return the
// one rigid transform that best maps `reference` onto `target`. The suspension uses it
// to let four contradictory wheel heights agree on one rigid chassis pose—roll, pitch,
// and ride-height emerge from the fit instead of being faked from steering input.
export function solveKabschTransform(reference, target) {
  if (!Array.isArray(reference) || !Array.isArray(target) || reference.length !== target.length || reference.length < 3) {
    return { rotation: { x: 0, y: 0, z: 0, w: 1 }, translation: { x: 0, y: 0, z: 0 }, residual: 0 };
  }
  const fromCenter = centroid(reference);
  const toCenter = centroid(target);
  const covariance = Array.from({ length: 3 }, () => [0, 0, 0]);
  reference.forEach((point, index) => {
    const p = [point.x - fromCenter.x, point.y - fromCenter.y, point.z - fromCenter.z];
    const q = [target[index].x - toCenter.x, target[index].y - toCenter.y, target[index].z - toCenter.z];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) covariance[row][column] += p[row] * q[column];
    }
  });
  const [[sxx, sxy, sxz], [syx, syy, syz], [szx, szy, szz]] = covariance;
  const horn = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  // Shift the symmetric matrix above zero so power iteration finds its greatest
  // algebraic eigenvalue rather than whichever signed eigenvalue has greatest magnitude.
  const shift = Math.max(...horn.map((row) => row.reduce((sum, value) => sum + Math.abs(value), 0))) + 1e-9;
  let vector = [1, 0, 0, 0];
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const next = horn.map((row, rowIndex) => row.reduce((sum, value, column) => sum + value * vector[column], shift * vector[rowIndex]));
    const length = Math.hypot(...next) || 1;
    vector = next.map((value) => value / length);
  }
  const rotation = { w: vector[0], x: vector[1], y: vector[2], z: vector[3] };
  const rotatedCenter = rotateByQuaternion(fromCenter, rotation);
  const translation = {
    x: toCenter.x - rotatedCenter.x,
    y: toCenter.y - rotatedCenter.y,
    z: toCenter.z - rotatedCenter.z,
  };
  const residual = Math.sqrt(reference.reduce((sum, point, index) => {
    const rotated = rotateByQuaternion(point, rotation);
    const dx = rotated.x + translation.x - target[index].x;
    const dy = rotated.y + translation.y - target[index].y;
    const dz = rotated.z + translation.z - target[index].z;
    return sum + dx * dx + dy * dy + dz * dz;
  }, 0) / reference.length);
  return { rotation, translation, residual };
}

export function solveVehicleSuspensionPose({
  x = 0,
  z = 0,
  heading = 0,
  centerHeight = 0,
  halfWidth = VEHICLE.bodyWidth * 0.57,
  halfLength = VEHICLE.bodyLength * 0.31,
  heightAt = () => centerHeight,
} = {}) {
  const reference = [
    { x: -halfWidth, y: 0, z: halfLength },
    { x: halfWidth, y: 0, z: halfLength },
    { x: -halfWidth, y: 0, z: -halfLength },
    { x: halfWidth, y: 0, z: -halfLength },
  ];
  const cosine = Math.cos(heading);
  const sine = Math.sin(heading);
  const wheelOffsets = reference.map((mount) => {
    const worldX = x + mount.x * cosine + mount.z * sine;
    const worldZ = z - mount.x * sine + mount.z * cosine;
    return heightAt(worldX, worldZ) - centerHeight;
  });
  const target = reference.map((mount, index) => ({ ...mount, y: wheelOffsets[index] }));
  const pose = solveKabschTransform(reference, target);
  // The rigid chassis pose already accounts for the shared slope under all four mounts.
  // Per-wheel travel is only the vertical residual that the best-fit plane could not
  // explain. Applying the full wheel offset again would double the slope: uphill tires
  // float while downhill tires sink even though the chassis is already tilted correctly.
  const wheelTravel = reference.map((mount, index) => {
    const fitted = rotateByQuaternion(mount, pose.rotation);
    return wheelOffsets[index] - (fitted.y + pose.translation.y);
  });
  return { ...pose, wheelOffsets, wheelTravel };
}

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
