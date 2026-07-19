import { useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import PlayerAvatar from './PlayerAvatar';
import ErrorBoundary from '../ErrorBoundary';
import {
  THIRD_PERSON, EYE_HEIGHT, BUILDING_COLLISION_RADIUS,
  thirdPersonCamera, resolveBoom,
  dampFactor, dampAngle, moveFacing, avatarState, bankAngle,
} from '../../utils/cityPlayerRig';
import { isWalkable, WORLD } from '../../utils/cityPlan';

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
//   - 'first' (V to toggle): the classic invisible first-person camera.
//   - 'third' (default): a damped follow camera behind a visible cyber-runner, with
//     building-aware boom shortening (cityPlayerRig.js owns all the math).
// All original behavior is preserved: WASD/arrows, shift sprint, E/Q vertical, F interact,
// pointer-lock mouselook, per-building cylinder collision below flyover height, world
// bounds, spawn persistence. New: ground movement can't walk into the bay (the harbor
// piers stay walkable — see isWalkable in cityPlan.js).
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
}) {
  const { camera, gl } = useThree();
  const rigRef = useRef({
    position: new THREE.Vector3(0, EYE_HEIGHT, 0),
    yaw: 0, // camera heading; forward is (-sin yaw, 0, -cos yaw)
    pitch: 0,
    facing: 0, // the character's body heading (damped toward movement direction)
    bank: 0, // lean into turns
    vy: 0, // vertical velocity for the Space jump arc (E/Q free-fly zeroes it)
    state: 'idle',
  });
  // Stable array view of the positions Map for the per-frame boom collision test —
  // re-collected only when the layout itself changes, never per frame.
  const buildingList = useMemo(() => (positions ? [...positions.values()] : []), [positions]);
  const lastSpawnRef = useRef(null);
  const pointerLockedRef = useRef(false);
  const proximityAppRef = useRef(null);
  // Damped third-person aim point — lags the true lookAt so the aim stays smooth.
  const lookRef = useRef(new THREE.Vector3());
  const lookInitRef = useRef(false);

  // Re-snap the aim whenever the camera mode flips (V) so the lerp never starts
  // from a stale aim point left by the previous third-person stint.
  useEffect(() => { lookInitRef.current = false; }, [cameraView]);

  // Initialize spawn position
  useEffect(() => {
    if (!active) return;
    const rig = rigRef.current;
    if (lastSpawnRef.current) {
      rig.position.copy(lastSpawnRef.current);
    } else {
      // Spawn behind front row, facing downtown
      let maxZ = 0;
      positions?.forEach((pos) => {
        if (pos.z > maxZ) maxZ = pos.z;
      });
      rig.position.set(0, EYE_HEIGHT, maxZ + 8);
      rig.yaw = 0; // Forward = (0, 0, -1), facing toward city center
      rig.pitch = 0;
      rig.facing = 0;
    }
    lookInitRef.current = false;
  }, [active, positions]);

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

  // F interacts with the nearby building; V swaps first/third person. (E is vertical-up
  // in the free-look controls, so neither shadows movement.)
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e) => {
      const key = e.key.toLowerCase();
      if (key === 'f' && proximityAppRef.current) {
        onBuildingClick?.(proximityAppRef.current);
      } else if (key === 'v') {
        onToggleCameraView?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onBuildingClick, onToggleCameraView]);

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
    const isSprinting = keys.has('shift');
    const speed = (isSprinting ? SPRINT_SPEED : WALK_SPEED) * delta;
    const verticalSpeed = (isSprinting ? SPRINT_SPEED : VERTICAL_SPEED) * delta;

    // Movement direction relative to camera yaw
    const forward = _forward.set(-Math.sin(rig.yaw), 0, -Math.cos(rig.yaw));
    const right = _right.set(-forward.z, 0, forward.x);

    const forwardInput = (keys.has('w') || keys.has('arrowup') ? 1 : 0)
      - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const strafeInput = (keys.has('d') || keys.has('arrowright') ? 1 : 0)
      - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    const moveDir = _moveDir.set(0, 0, 0)
      .addScaledVector(forward, forwardInput)
      .addScaledVector(right, strafeInput);

    const hasHorizontal = moveDir.lengthSq() > 0;

    // Vertical: E/Q is direct free-fly and takes precedence (zeroing any jump arc);
    // otherwise Space launches a gravity-based jump from the ground. The arc integrates
    // rig.vy so the runner hops and lands rather than floating; landing (clamp to
    // EYE_HEIGHT below) resets rig.vy. Holding Space re-jumps on touchdown.
    const flyDir = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
    const grounded = rig.position.y <= EYE_HEIGHT + 1e-3;
    let dy = 0;
    if (flyDir !== 0) {
      rig.vy = 0;
      dy = flyDir * verticalSpeed;
    } else {
      if (keys.has(' ') && grounded && rig.vy <= 0) rig.vy = JUMP_SPEED; // launch
      if (!grounded || rig.vy > 0) {
        rig.vy += GRAVITY * delta; // gravity through the arc
        dy = rig.vy * delta;
      } else {
        rig.vy = 0;
      }
    }
    const moving = hasHorizontal || dy !== 0;

    if (moving) {
      if (hasHorizontal) moveDir.normalize().multiplyScalar(speed);
      const nextPos = _nextPos.copy(rig.position).add(moveDir);
      nextPos.y += dy;

      // Collision detection with buildings — skipped above rooftop height so the
      // player can fly over the city.
      let blocked = false;
      if (hasHorizontal && nextPos.y < BUILDING_FLYOVER_HEIGHT) {
        positions?.forEach((pos) => {
          const dx = nextPos.x - pos.x;
          const dz = nextPos.z - pos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < BUILDING_COLLISION_RADIUS) {
            // Slide along boundary tangent
            const nx = dx / dist;
            const nz = dz / dist;
            const dot = moveDir.x * nx + moveDir.z * nz;
            if (dot < 0) {
              // Moving toward building - project movement onto tangent
              nextPos.x = rig.position.x + (moveDir.x - dot * nx) * 0.8;
              nextPos.z = rig.position.z + (moveDir.z - dot * nz) * 0.8;
              // Re-check distance after slide
              const dx2 = nextPos.x - pos.x;
              const dz2 = nextPos.z - pos.z;
              if (Math.sqrt(dx2 * dx2 + dz2 * dz2) < BUILDING_COLLISION_RADIUS) {
                blocked = true;
              }
            }
          }
        });
        // The bay is not walkable (the harbor piers are) — a grounded player stops
        // at the shoreline instead of strolling onto open water.
        if (!isWalkable(nextPos.x, nextPos.z)) blocked = true;
      }

      if (!blocked) {
        // World bounds
        nextPos.x = Math.max(-WORLD.bound, Math.min(WORLD.bound, nextPos.x));
        nextPos.y = Math.max(EYE_HEIGHT, Math.min(MAX_CAMERA_HEIGHT, nextPos.y));
        nextPos.z = Math.max(-WORLD.bound, Math.min(WORLD.bound, nextPos.z));
        // Landed (or hit the ceiling): kill the jump's vertical velocity.
        if (nextPos.y <= EYE_HEIGHT + 1e-3 || nextPos.y >= MAX_CAMERA_HEIGHT) rig.vy = 0;
        rig.position.copy(nextPos);
      }
    }

    // Pose classification for the avatar + facing/banking toward movement.
    rig.state = avatarState({
      moving,
      sprinting: isSprinting && moving,
      airborne: rig.position.y > AIRBORNE_HEIGHT,
    });
    if (hasHorizontal) {
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
    const desired = thirdPersonCamera({ pos: rig.position, yaw: rig.yaw, pitch: rig.pitch });
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

  // The visible character exists only in third person — first person stays the
  // classic invisible camera (and can't self-clip). PlayerAvatar loads a rigged GLB
  // (useGLTF suspends), so it's wrapped: Suspense keeps the streaming model from
  // blanking the whole city canvas, and the error boundary degrades to "no visible
  // runner" if the GLB is missing/corrupt (e.g. a checkout without `npm run setup:data`)
  // rather than crashing the scene.
  if (cameraView !== 'third') return null;
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={null}>
        <PlayerAvatar rigRef={rigRef} />
      </Suspense>
    </ErrorBoundary>
  );
}
