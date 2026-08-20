import { useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import PlayerAvatar from './PlayerAvatar';
import ErrorBoundary from '../ErrorBoundary';
import {
  THIRD_PERSON, EYE_HEIGHT, DEFAULT_SPAWN_Z,
  thirdPersonCamera, resolveBoom,
  dampFactor, dampAngle, moveFacing, avatarState, bankAngle, stepVehicle,
  moveWithCollisions, PLAYER_COLLISION_RADIUS, VEHICLE_COLLISION,
} from '../../utils/openWorldPlayerRig';
import { isWalkable, WORLD } from '../../utils/openWorldPlan';
import { BOROUGH_PARAMS, BUILDING_PARAMS, PROCESS_BUILDING_PARAMS } from './openWorldConstants';
import { regionWarpPadPosition } from '../../utils/openWorldRegions';

const WALK_SPEED = 10;
const SPRINT_SPEED = 20;
const VERTICAL_SPEED = 8;
const JUMP_SPEED = 10;  // initial upward velocity of a Space jump (units/s)
const GRAVITY = -26;    // downward acceleration applied through the jump arc (units/s²)
const PROXIMITY_DISTANCE = 6;
const MAX_CAMERA_HEIGHT = 160;
const BUILDING_FLYOVER_HEIGHT = 12; // above this the player clears rooftops, so skip collision
const AIRBORNE_HEIGHT = EYE_HEIGHT + 0.6; // above this the avatar reads as flying (hover state)
const MOUSE_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI / 2 - 0.02;

// Frame-loop scratch vectors (module scope — no per-frame allocation in useFrame).
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _nextPos = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();

// Exploration-mode player rig. One mutable rig object is the single source of truth for
// the player's pose; both camera modes (and the third-person avatar) read from it:
//   - 'third' (default): a damped follow camera behind a visible low-poly rover with
//     arcade vehicle handling, building-aware boom shortening, and speed-weighted steering.
//   - 'first' (V to toggle): the classic invisible first-person camera.
// WASD/arrows, shift boost, E/Q vertical, F interact, R respawn, pointer-lock mouselook,
// shape-aware building/pylon collision below flyover height, world bounds, and spawn
// persistence remain available. Ground movement can't enter the bay (the harbor piers stay
// walkable — see isWalkable in openWorldPlan.js).
export default function PlayerController({
  keysRef,
  positions,
  onBuildingProximity,
  onBuildingClick,
  onToggleCameraView,
  apps,
  active,
  transitioning = false,
  cameraView = 'third',
  teleport = null,
  warpPads = [],
  onWarpPadInteract,
  onWarpPadProximity,
  mobileInputRef = null,
  playerActionRef = null,
}) {
  const { camera, gl } = useThree();
  const rigRef = useRef({
    position: new THREE.Vector3(0, EYE_HEIGHT, 0),
    yaw: THIRD_PERSON.isometricYaw, // camera heading; forward is (-sin yaw, 0, -cos yaw)
    heading: THIRD_PERSON.isometricYaw, // rover heading; camera orbit can look independently
    pitch: 0,
    facing: THIRD_PERSON.isometricYaw, // the character's body heading (damped toward movement direction)
    bank: 0, // lean into turns
    speed: 0, // signed rover speed; positive forward, negative reverse
    wheelAngle: 0,
    skid: 0,
    vy: 0, // vertical velocity for the Space jump arc (E/Q free-fly zeroes it)
    jumping: false, // an active Space jump arc — gates gravity so E/Q free-fly holds altitude
    state: 'idle',
  });
  // Stable array view of the positions Map for the per-frame boom collision test —
  // re-collected only when the layout itself changes, never per frame.
  const buildingList = useMemo(() => (positions ? [...positions.values()] : []), [positions]);
  // Movement colliders mirror the rendered footprint: app buildings are boxes and
  // process pylons are round. The boom keeps its own larger camera-only padding above.
  const collisionShapes = useMemo(() => {
    if (!positions) return [];
    const appById = new Map((apps || []).map((app) => [app.id, app]));
    const shapes = [];

    positions.forEach((pos, appId) => {
      shapes.push({
        shape: 'box',
        x: pos.x,
        z: pos.z,
        halfWidth: BUILDING_PARAMS.width / 2,
        halfDepth: BUILDING_PARAMS.depth / 2,
      });

      const app = appById.get(appId);
      const processCount = app?.archived || !Array.isArray(app?.processes) ? 0 : app.processes.length;
      const processRadius = Math.max(PROCESS_BUILDING_PARAMS.width, PROCESS_BUILDING_PARAMS.depth) * 0.58;
      for (let index = 0; index < processCount; index += 1) {
        const angle = (index / processCount) * Math.PI * 2;
        shapes.push({
          shape: 'circle',
          x: pos.x + Math.cos(angle) * BOROUGH_PARAMS.processRingRadius,
          z: pos.z + Math.sin(angle) * BOROUGH_PARAMS.processRingRadius,
          radius: processRadius,
        });
      }
    });

    return shapes;
  }, [apps, positions]);
  const warpPadList = useMemo(
    () => warpPads.map((region) => ({ region, position: regionWarpPadPosition(region) })).filter((entry) => entry.position),
    [warpPads],
  );
  const lastSpawnRef = useRef(null);
  const pointerLockedRef = useRef(false);
  const proximityAppRef = useRef(null);
  const proximityWarpPadRef = useRef(null);
  // Damped third-person aim point — lags the true lookAt so the aim stays smooth.
  const lookRef = useRef(new THREE.Vector3());
  const lookInitRef = useRef(false);

  // Re-snap the aim whenever the camera mode flips (V) so the lerp never starts
  // from a stale aim point left by the previous third-person stint.
  useEffect(() => {
    const rig = rigRef.current;
    // A camera-mode change is also a clean handoff: first person inherits the current
    // rover heading, and returning to the rover starts with the camera's current aim.
    rig.heading = rig.yaw;
    rig.facing = rig.yaw;
    rig.speed = 0;
    rig.wheelAngle = 0;
    rig.skid = 0;
    lookInitRef.current = false;
  }, [cameraView]);

  // Initialize spawn position
  useEffect(() => {
    const rig = rigRef.current;
    if (!active) {
      // Orbital mode pauses the frame loop. Clear a partially applied throttle so
      // dropping back into the street never resumes with stale momentum.
      rig.speed = 0;
      rig.wheelAngle = 0;
      rig.skid = 0;
      rig.vy = 0;
      rig.jumping = false;
      return;
    }
    if (lastSpawnRef.current) {
      rig.position.copy(lastSpawnRef.current);
    } else {
      // Spawn behind front row, facing downtown
      let maxZ = 0;
      positions?.forEach((pos) => {
        if (pos.z > maxZ) maxZ = pos.z;
      });
      // With an empty or single-app install, `maxZ + 8` places the rover inside the
      // central plaza's sightline and the AI Core fills the entire mobile viewport.
      // Keep the same city-facing drop-in, but start far enough back to reveal the
      // playable streets and landmarks before the player drives toward downtown.
      rig.position.set(0, EYE_HEIGHT, Math.max(maxZ + 8, DEFAULT_SPAWN_Z));
      rig.yaw = THIRD_PERSON.isometricYaw;
      rig.heading = THIRD_PERSON.isometricYaw;
      rig.pitch = 0;
      rig.facing = THIRD_PERSON.isometricYaw;
      rig.speed = 0;
      rig.wheelAngle = 0;
      rig.skid = 0;
      lastSpawnRef.current = rig.position.clone();
    }
    lookInitRef.current = false;
  }, [active, positions]);

  // Fast travel while on foot: warping to a region drops the player at its arrival point
  // instead of moving only the orbital camera. `teleport.token` is the trigger — the same
  // destination can be re-selected, and a plain {x,z} identity check would swallow the
  // second warp. Keyed on the token alone so a re-render with an equal object is a no-op.
  const teleportToken = teleport?.token ?? null;
  useEffect(() => {
    if (!active || teleportToken === null || !teleport) return;
    const rig = rigRef.current;
    rig.position.set(teleport.x, EYE_HEIGHT, teleport.z);
    // Face the destination from the same diagonal heading as the default isometric view.
    rig.yaw = THIRD_PERSON.isometricYaw;
    rig.heading = THIRD_PERSON.isometricYaw;
    rig.pitch = 0;
    rig.facing = THIRD_PERSON.isometricYaw;
    rig.speed = 0;
    rig.wheelAngle = 0;
    rig.skid = 0;
    rig.vy = 0;
    rig.jumping = false;
    lastSpawnRef.current = rig.position.clone();
    lookInitRef.current = false;
    // `teleport` is read for its coordinates but is not the trigger — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, teleportToken]);

  // Pointer lock management
  const handleClick = useCallback(() => {
    if (!active) return;
    gl.domElement.requestPointerLock?.();
  }, [active, gl.domElement]);

  const handlePointerLockChange = useCallback(() => {
    pointerLockedRef.current = document.pointerLockElement === gl.domElement;
  }, [gl.domElement]);

  const handleMouseMove = useCallback((e) => {
    if (!pointerLockedRef.current || !active) return;
    const rig = rigRef.current;
    rig.yaw -= e.movementX * MOUSE_SENSITIVITY;
    rig.pitch -= e.movementY * MOUSE_SENSITIVITY;
    rig.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, rig.pitch));
  }, [active]);

  useEffect(() => {
    if (!active) {
      // Release pointer lock when leaving exploration mode
      if (document.pointerLockElement === gl.domElement) {
        document.exitPointerLock?.();
      }
      // Save last position for re-entry
      lastSpawnRef.current = rigRef.current.position.clone();
      return;
    }

    const canvas = gl.domElement;
    canvas.addEventListener('click', handleClick);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('mousemove', handleMouseMove);

    return () => {
      canvas.removeEventListener('click', handleClick);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      document.removeEventListener('mousemove', handleMouseMove);
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock?.();
      }
    };
  }, [active, gl.domElement, handleClick, handlePointerLockChange, handleMouseMove]);

  // F interacts with the nearby building; V swaps first/third person; R returns to the
  // current drop-in point. (E is vertical-up in the free-look controls, so neither shadows movement.)
  const interact = useCallback(() => {
    if (!active) return;
    if (proximityWarpPadRef.current) {
      onWarpPadInteract?.(proximityWarpPadRef.current);
    } else if (proximityAppRef.current) {
      onBuildingClick?.(proximityAppRef.current);
    }
  }, [active, onBuildingClick, onWarpPadInteract]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e) => {
      const key = e.key.toLowerCase();
      if (key === 'f') {
        interact();
      } else if (key === 'v') {
        onToggleCameraView?.();
      } else if (key === 'r' && lastSpawnRef.current) {
        rigRef.current.position.copy(lastSpawnRef.current);
        rigRef.current.yaw = THIRD_PERSON.isometricYaw;
        rigRef.current.heading = THIRD_PERSON.isometricYaw;
        rigRef.current.pitch = 0;
        rigRef.current.facing = THIRD_PERSON.isometricYaw;
        rigRef.current.speed = 0;
        rigRef.current.wheelAngle = 0;
        rigRef.current.skid = 0;
        rigRef.current.vy = 0;
        rigRef.current.jumping = false;
        lookInitRef.current = false;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, interact, onToggleCameraView]);

  useEffect(() => {
    if (!playerActionRef) return undefined;
    playerActionRef.current = { interact };
    return () => {
      if (playerActionRef.current?.interact === interact) playerActionRef.current = null;
    };
  }, [interact, playerActionRef]);

  // In exploration mode, Space is the jump key — capture it before it bubbles to the
  // global voice push-to-talk hotkey (VoiceWidget listens for the same key on `window`).
  // A CAPTURE-phase listener runs ahead of that bubble listener, so stopImmediatePropagation
  // suppresses the voice toggle (and the page's default space-scroll). Because that also
  // stops useKeyboardControls' own keydown, we record Space into keysRef here ourselves so
  // the jump still reads it in the frame loop. Skipped while typing so a focused field keeps
  // its spaces (matches VoiceWidget's own guard).
  useEffect(() => {
    if (!active) return undefined;
    const isTypingTarget = (el) => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };
    const onKeyDownCapture = (e) => {
      if (e.code !== 'Space' || isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      keysRef.current.add(' ');
    };
    const onKeyUpCapture = (e) => {
      if (e.code !== 'Space') return;
      keysRef.current.delete(' ');
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    window.addEventListener('keyup', onKeyUpCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true);
      window.removeEventListener('keyup', onKeyUpCapture, true);
      keysRef.current.delete(' ');
    };
  }, [active, keysRef]);

  useFrame((_, delta) => {
    if (!active) return;
    const rig = rigRef.current;

    const keys = keysRef.current;
    const mobileInput = mobileInputRef?.current;
    if (mobileInput) {
      const lookDeltaX = mobileInput.lookDeltaX || 0;
      const lookDeltaY = mobileInput.lookDeltaY || 0;
      mobileInput.lookDeltaX = 0;
      mobileInput.lookDeltaY = 0;
      rig.yaw -= lookDeltaX * MOUSE_SENSITIVITY;
      rig.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, rig.pitch - lookDeltaY * MOUSE_SENSITIVITY));
    }

    const isVehicle = cameraView === 'third';
    const isSprinting = keys.has('shift') || Boolean(mobileInput?.boost);
    const speed = (isSprinting ? SPRINT_SPEED : WALK_SPEED) * delta;
    const verticalSpeed = (isSprinting ? SPRINT_SPEED : VERTICAL_SPEED) * delta;
    const keyboardForward = (keys.has('w') || keys.has('arrowup') ? 1 : 0)
      - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const keyboardStrafe = (keys.has('d') || keys.has('arrowright') ? 1 : 0)
      - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const forwardInput = THREE.MathUtils.clamp(keyboardForward - (mobileInput?.moveY || 0), -1, 1);
    const strafeInput = THREE.MathUtils.clamp(keyboardStrafe + (mobileInput?.moveX || 0), -1, 1);
    const brake = keys.has('control') || keys.has('x');
    const previousHeading = rig.heading;
    const moveDir = _moveDir.set(0, 0, 0);
    if (isVehicle) {
      // Third-person is a rover: left/right steer the nose, while the analog stick's
      // horizontal axis remains the same steering input on touch devices. The camera yaw
      // stays independent so a player can look around while carrying speed.
      const drive = stepVehicle({
        speed: rig.speed,
        heading: rig.heading,
        wheelAngle: rig.wheelAngle,
        throttle: forwardInput,
        steer: strafeInput,
        boost: isSprinting,
        brake,
        delta,
      });
      rig.speed = drive.speed;
      rig.heading = drive.heading;
      rig.wheelAngle = drive.wheelAngle;
      rig.skid = drive.skid;
      moveDir.set(drive.displacement.x, 0, drive.displacement.z);
    } else {
      // First person remains the useful free-roam inspection mode: movement stays relative
      // to the mouse aim and keeps the original walk/fly behavior.
      const forward = _forward.set(-Math.sin(rig.yaw), 0, -Math.cos(rig.yaw));
      const right = _right.set(-forward.z, 0, forward.x);
      moveDir
        .addScaledVector(forward, forwardInput)
        .addScaledVector(right, strafeInput);
      if (moveDir.lengthSq() > 0) moveDir.normalize().multiplyScalar(speed);
      rig.heading = rig.yaw;
      rig.speed = 0;
      rig.wheelAngle = 0;
      rig.skid = 0;
    }
    const hasHorizontal = moveDir.lengthSq() > 0;

    // Vertical: E/Q is direct free-fly and takes precedence — it cancels any jump and
    // holds altitude when released (no gravity). Gravity applies ONLY during an active
    // Space jump arc (rig.jumping), so releasing E mid-air keeps the free-fly hover intact
    // instead of dropping the player. A jump launches only from the ground; the arc
    // integrates rig.vy until the landing/ceiling clamp below clears rig.jumping.
    const flyDir = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
    const grounded = rig.position.y <= EYE_HEIGHT + 1e-3;
    let dy = 0;
    if (flyDir !== 0) {
      rig.jumping = false;
      rig.vy = 0;
      dy = flyDir * verticalSpeed;
    } else {
      if ((keys.has(' ') || mobileInput?.jump) && grounded && !rig.jumping) { rig.vy = JUMP_SPEED; rig.jumping = true; } // launch
      if (rig.jumping) {
        rig.vy += GRAVITY * delta; // gravity through the arc
        dy = rig.vy * delta;
      }
    }
    const hasMotionIntent = hasHorizontal || dy !== 0;
    let movedHorizontally = false;

    if (hasMotionIntent) {
      const startX = rig.position.x;
      const startZ = rig.position.z;
      const nextPos = _nextPos.copy(rig.position).add(moveDir);
      nextPos.y += dy;

      // Collision detection is skipped above rooftop height so the player can fly over
      // the city. The resolver stops at the actual facade/pylon contact and preserves
      // the free axis for a stable wall slide.
      let blocked = false;
      if (hasHorizontal && nextPos.y < BUILDING_FLYOVER_HEIGHT) {
        const collision = moveWithCollisions({
          position: rig.position,
          displacement: { x: moveDir.x, z: moveDir.z },
          colliders: collisionShapes,
          body: isVehicle
            ? { type: 'vehicle', heading: rig.heading, ...VEHICLE_COLLISION }
            : { type: 'circle', radius: PLAYER_COLLISION_RADIUS },
        });
        nextPos.x = collision.x;
        nextPos.z = collision.z;
        blocked = collision.blocked;
        // The bay is not walkable (the harbor piers are) — a grounded player stops
        // at the shoreline instead of strolling onto open water.
        if (!isWalkable(nextPos.x, nextPos.z)) {
          blocked = true;
          // Water is a hard terrain boundary rather than a wall: undo the whole
          // attempted move so the player cannot slide diagonally onto the bay.
          nextPos.x = rig.position.x;
          nextPos.z = rig.position.z;
        }
      }

      // Vertical (jump/gravity) is independent of horizontal collision: a wall only
      // stops horizontal progress, never the jump arc. The resolver has already placed
      // the player at the contact point (and kept any tangent slide); terrain boundaries
      // were reset above. In either case the hop still rises, falls, and lands rather
      // than freezing mid-air while vy keeps integrating downward.
      if (blocked) {
        if (isVehicle) rig.speed = 0;
      }
      // World bounds
      nextPos.x = Math.max(-WORLD.bound, Math.min(WORLD.bound, nextPos.x));
      nextPos.y = Math.max(EYE_HEIGHT, Math.min(MAX_CAMERA_HEIGHT, nextPos.y));
      nextPos.z = Math.max(-WORLD.bound, Math.min(WORLD.bound, nextPos.z));
      // Landed (or hit the ceiling): end the jump arc so gravity stops and Space can
      // launch again (and so releasing E above ground doesn't inherit a stale arc).
      if (nextPos.y <= EYE_HEIGHT + 1e-3 || nextPos.y >= MAX_CAMERA_HEIGHT) {
        rig.vy = 0;
        rig.jumping = false;
      }
      movedHorizontally = Math.abs(nextPos.x - startX) > 1e-5 || Math.abs(nextPos.z - startZ) > 1e-5;
      rig.position.copy(nextPos);
    }

    // Pose classification for the avatar + facing/banking toward movement.
    const moving = movedHorizontally || dy !== 0;
    rig.state = avatarState({
      moving,
      sprinting: isVehicle ? Math.abs(rig.speed) > 16 || (isSprinting && moving) : isSprinting && moving,
      airborne: rig.position.y > AIRBORNE_HEIGHT,
    });
    if (isVehicle) {
      const prevFacing = rig.facing;
      rig.facing = dampAngle(rig.facing, rig.heading, dampFactor(14, delta));
      const headingStep = delta > 0 ? (dampAngle(previousHeading, rig.heading, 1) - previousHeading) / delta : 0;
      const turnBank = bankAngle(headingStep, 0.24, 0.045) + rig.wheelAngle * rig.skid * 0.08;
      rig.bank += (turnBank - rig.bank) * dampFactor(8, delta);
      // Keep the facing value live even while coasting to a stop; the visual rover should
      // settle into the same heading as the steering math rather than snap at zero speed.
      if (!movedHorizontally && Math.abs(prevFacing - rig.heading) < 0.001) rig.facing = rig.heading;
    } else if (movedHorizontally) {
      const target = moveFacing(rig.yaw, { forward: forwardInput, strafe: strafeInput });
      const prevFacing = rig.facing;
      rig.facing = dampAngle(rig.facing, target, dampFactor(10, delta));
      const yawRate = delta > 0 ? (rig.facing - prevFacing) / delta : 0;
      rig.bank += (bankAngle(yawRate) - rig.bank) * dampFactor(6, delta);
    } else {
      rig.bank += (0 - rig.bank) * dampFactor(6, delta);
    }

    // Building proximity detection
    let nearestApp = null;
    let nearestDist = PROXIMITY_DISTANCE;
    positions?.forEach((pos, appId) => {
      const dx = rig.position.x - pos.x;
      const dy = rig.position.y - ((pos.height ?? 4) * 0.5);
      const dz = rig.position.z - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        const app = apps?.find(a => a.id === appId);
        if (app) nearestApp = app;
      }
    });

    if (nearestApp !== proximityAppRef.current) {
      proximityAppRef.current = nearestApp;
      onBuildingProximity?.(nearestApp);
    }

    let nearestWarpPad = null;
    let nearestWarpDistance = 3.6;
    for (const { region, position } of warpPadList) {
      const [x, y, z] = position;
      const dx = rig.position.x - x;
      const dy = rig.position.y - y;
      const dz = rig.position.z - z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance < nearestWarpDistance) {
        nearestWarpDistance = distance;
        nearestWarpPad = region;
      }
    }
    if (nearestWarpPad !== proximityWarpPadRef.current) {
      proximityWarpPadRef.current = nearestWarpPad;
      onWarpPadProximity?.(nearestWarpPad);
    }

    // Camera application. While CameraTransition flies the camera (exploration toggle),
    // it is the sole camera writer — explicit gate instead of relying on mount order.
    if (transitioning) return;

    if (cameraView === 'first') {
      camera.position.copy(rig.position);
      const lookDir = _lookDir.set(
        -Math.sin(rig.yaw) * Math.cos(rig.pitch),
        Math.sin(rig.pitch),
        -Math.cos(rig.yaw) * Math.cos(rig.pitch),
      );
      camera.lookAt(_lookTarget.copy(rig.position).add(lookDir));
      return;
    }

    // Third person: boom behind the camera yaw, shortened when it would clip a building,
    // damped so the camera glides while the aim stays tight.
    const desired = thirdPersonCamera({
      pos: rig.position,
      yaw: rig.yaw,
      pitch: rig.pitch,
      pitchOffset: THIRD_PERSON.isometricPitch,
    });
    const anchor = { x: rig.position.x, y: rig.position.y + THIRD_PERSON.lookHeight, z: rig.position.z };
    const { point: resolvedCam } = resolveBoom({ anchor, camera: desired.camera, buildings: buildingList });

    if (!lookInitRef.current) {
      // First third-person frame (mode entry): aim snaps so the camera doesn't swing
      // through the scene; position still eases in from wherever the camera was.
      lookRef.current.set(desired.lookAt.x, desired.lookAt.y, desired.lookAt.z);
      lookInitRef.current = true;
    }
    const posFactor = dampFactor(THIRD_PERSON.camDampRate, delta);
    const lookFactor = dampFactor(THIRD_PERSON.lookDampRate, delta);
    camera.position.lerp(_camTarget.set(resolvedCam.x, resolvedCam.y, resolvedCam.z), posFactor);
    lookRef.current.lerp(_lookTarget.set(desired.lookAt.x, desired.lookAt.y, desired.lookAt.z), lookFactor);
    camera.lookAt(lookRef.current);
  });

  if (!active) return null;

  // The visible vehicle exists only in third person — first person stays the classic
  // invisible camera (and can't self-clip). The procedural actor is still wrapped by the
  // existing boundaries so the scene keeps its defensive mount contract.
  if (cameraView !== 'third') return null;
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={null}>
        <PlayerAvatar rigRef={rigRef} />
      </Suspense>
    </ErrorBoundary>
  );
}
