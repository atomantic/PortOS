import { useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import PlayerAvatar from './PlayerAvatar';
import useKeyCapture from '../../hooks/useKeyCapture';
import ErrorBoundary from '../ErrorBoundary';
import {
  THIRD_PERSON, EYE_HEIGHT, DEFAULT_SPAWN_Z,
  thirdPersonCamera, resolveBoom, nextBoomZoom,
  dampFactor, dampAngle, moveFacing, avatarState, bankAngle, stepVehicle,
  moveWithCollisions, PLAYER_COLLISION_RADIUS, VEHICLE_COLLISION,
} from '../../utils/openWorldPlayerRig';
import { isWalkable, WORLD } from '../../utils/openWorldPlan';
import { BOROUGH_PARAMS, BUILDING_PARAMS, PROCESS_BUILDING_PARAMS } from './openWorldConstants';
import { regionWarpPadPosition, getRegion } from '../../utils/openWorldRegions';
import { checkSpeedPadOverlap } from '../../utils/openWorldSpeedPads';
import { checkShardCollection, getCollectiblesList } from '../../utils/openWorldCollectibles';
import { detectProximity, getResolvedLandmarks } from '../../utils/openWorldProximity';

const WALK_SPEED = 10;
const SPRINT_SPEED = 20;
const VERTICAL_SPEED = 8;
const JUMP_SPEED = 10;  // initial upward velocity of a Space jump (units/s)
const GRAVITY = -26;    // downward acceleration applied through the jump arc (units/s²)
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
// WASD/arrows, shift boost, E/Q vertical, F interact, R respawn, H horn, pointer-lock mouselook,
// scroll-wheel camera zoom, speed boost pads, cyber shards collection, landmark discovery, and
// world boundaries.
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
  landmarks = getResolvedLandmarks(),
  onWarpPadInteract,
  onWarpPadProximity,
  onProximityChange,
  easterEggs = [],
  shards = getCollectiblesList(),
  collectedShardIds = new Set(),
  onCollectShard,
  onPlayerPoseChange,
  playSfx,
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
  const proximityTargetRef = useRef(null);
  const lastBoostPadRef = useRef(null);
  const boostOverrideTimerRef = useRef(0);
  const localCollectedSetRef = useRef(new Set(collectedShardIds));
  const poseTickRef = useRef(0);
  const lastSpawnRef = useRef(null);
  const pointerLockedRef = useRef(false);
  // Camera boom zoom: `boomZoomTargetRef` is the player's chosen multiplier, `boomZoomRef`
  // the smoothed value the camera actually uses this frame.
  const boomZoomTargetRef = useRef(1);
  const boomZoomRef = useRef(1);

  useEffect(() => {
    localCollectedSetRef.current = new Set(collectedShardIds);
  }, [collectedShardIds]);

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

  // Wheel zooms the third-person boom. Bound on the canvas (not window) so HUD panels
  // and dialogs keep their own scroll; preventDefault stops any residual page scroll.
  const handleWheel = useCallback((e) => {
    if (!active) return;
    e.preventDefault();
    boomZoomTargetRef.current = nextBoomZoom(boomZoomTargetRef.current, e.deltaY);
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
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      canvas.removeEventListener('click', handleClick);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      document.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('wheel', handleWheel);
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock?.();
      }
    };
  }, [active, gl.domElement, handleClick, handlePointerLockChange, handleMouseMove, handleWheel]);

  // F interacts with the nearby target; V swaps first/third person; H plays horn; R returns to drop-in.
  const interact = useCallback(() => {
    if (!active) return;
    const target = proximityTargetRef.current;
    if (!target) return;
    if (target.type === 'warpPad') {
      onWarpPadInteract?.(target.raw);
    } else if (target.type === 'building') {
      onBuildingClick?.(target.raw);
    } else if (target.type === 'landmark') {
      if (target.regionId) {
        const region = getRegion(target.regionId);
        if (region) onWarpPadInteract?.(region);
      }
    } else if (target.type === 'easterEgg') {
      playSfx?.('eggDiscover');
    }
  }, [active, onBuildingClick, onWarpPadInteract, playSfx]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e) => {
      const key = e.key.toLowerCase();
      if (key === 'f') {
        interact();
      } else if (key === 'v') {
        onToggleCameraView?.();
      } else if (key === 'h') {
        playSfx?.('horn');
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
  }, [active, interact, onToggleCameraView, playSfx]);

  useEffect(() => {
    if (!playerActionRef) return undefined;
    playerActionRef.current = { interact };
    return () => {
      if (playerActionRef.current?.interact === interact) playerActionRef.current = null;
    };
  }, [interact, playerActionRef]);

  // In exploration mode, Space is the jump key — claim it in the capture phase so it
  // never reaches the global voice push-to-talk hotkey (VoiceWidget listens for the
  // same key on `window`). Claiming the keydown is also what stops useKeyboardControls
  // from recording the hold, hence the manual add here; the release needs no handler,
  // because that keyup is NOT claimed and useKeyboardControls clears the key itself.
  useKeyCapture({
    enabled: active,
    onKeyDown: (e) => {
      if (e.code !== 'Space') return false;
      keysRef.current.add(' ');
      return true;
    },
  });

  // Drop a held jump when exploration mode ends — the keyup that would have cleared it
  // can land after the mode switch, and the rig would resume mid-jump on re-entry.
  useEffect(() => () => { keysRef.current.delete(' '); }, [active, keysRef]);

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
      // horizontal axis remains the same steering input on touch devices.
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
      // First person remains the useful free-roam inspection mode.
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
    // Space jump arc.
    const flyDir = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
    const grounded = rig.position.y <= EYE_HEIGHT + 1e-3;
    let dy = 0;
    if (flyDir !== 0) {
      rig.jumping = false;
      rig.vy = 0;
      dy = flyDir * verticalSpeed;
    } else {
      if ((keys.has(' ') || mobileInput?.jump) && grounded && !rig.jumping) {
        rig.vy = JUMP_SPEED;
        rig.jumping = true;
        playSfx?.('jump');
      }
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
      // the city.
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
        if (!isWalkable(nextPos.x, nextPos.z)) {
          blocked = true;
          nextPos.x = rig.position.x;
          nextPos.z = rig.position.z;
        }
      }

      if (blocked) {
        if (isVehicle) rig.speed = 0;
      }
      // World bounds
      nextPos.x = Math.max(-WORLD.bound, Math.min(WORLD.bound, nextPos.x));
      nextPos.y = Math.max(EYE_HEIGHT, Math.min(MAX_CAMERA_HEIGHT, nextPos.y));
      nextPos.z = Math.max(-WORLD.bound, Math.min(WORLD.bound, nextPos.z));

      // Landed
      if (nextPos.y <= EYE_HEIGHT + 1e-3 || nextPos.y >= MAX_CAMERA_HEIGHT) {
        if (rig.jumping && nextPos.y <= EYE_HEIGHT + 1e-3) {
          playSfx?.('land');
        }
        rig.vy = 0;
        rig.jumping = false;
      }
      movedHorizontally = Math.abs(nextPos.x - startX) > 1e-5 || Math.abs(nextPos.z - startZ) > 1e-5;
      rig.position.copy(nextPos);
    }

    // Speed boost pads detection and duration handling
    const activeBoostPad = checkSpeedPadOverlap(rig.position);
    if (activeBoostPad && lastBoostPadRef.current !== activeBoostPad.id) {
      lastBoostPadRef.current = activeBoostPad.id;
      boostOverrideTimerRef.current = 1.4;
      if (isVehicle) {
        rig.speed = Math.max(rig.speed, activeBoostPad.boostSpeed);
      }
      playSfx?.('boostPad');
    } else if (!activeBoostPad) {
      lastBoostPadRef.current = null;
    }

    if (boostOverrideTimerRef.current > 0) {
      boostOverrideTimerRef.current -= delta;
    }

    // Cyber Shards collectible detection
    const collectedShards = checkShardCollection(rig.position, shards, localCollectedSetRef.current);
    if (collectedShards.length > 0) {
      collectedShards.forEach((shard) => {
        localCollectedSetRef.current.add(shard.id);
        onCollectShard?.(shard);
        playSfx?.('collect');
      });
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

    const proxTarget = detectProximity({
      playerPos: rig.position,
      apps,
      positions,
      warpPads: warpPadList,
      easterEggs,
      landmarks,
    });

    if (proxTarget?.id !== proximityTargetRef.current?.id || proxTarget?.type !== proximityTargetRef.current?.type) {
      proximityTargetRef.current = proxTarget;
      onBuildingProximity?.(proxTarget?.type === 'building' ? proxTarget.raw : null);
      onWarpPadProximity?.(proxTarget?.type === 'warpPad' ? proxTarget.raw : null);
      onProximityChange?.(proxTarget);
    }

    const reportingSpeed = isVehicle
      ? rig.speed
      : (hasHorizontal ? (isSprinting ? SPRINT_SPEED : WALK_SPEED) * (forwardInput < 0 ? -1 : 1) : 0);

    poseTickRef.current = (poseTickRef.current || 0) + 1;
    if (poseTickRef.current % 3 === 0) {
      onPlayerPoseChange?.({
        x: rig.position.x,
        y: rig.position.y,
        z: rig.position.z,
        heading: rig.heading,
        speed: reportingSpeed,
        skid: rig.skid,
        state: rig.state,
        jumping: rig.jumping,
        airborne: rig.position.y > AIRBORNE_HEIGHT,
        boosting: isSprinting,
      });
    }

    // Camera application
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

    // Third person: boom behind camera yaw. The wheel multiplier eases toward its
    // target so a fast scroll produces a smooth dolly instead of a jump cut.
    boomZoomRef.current += (boomZoomTargetRef.current - boomZoomRef.current) * dampFactor(9, delta);
    const desired = thirdPersonCamera({
      pos: rig.position,
      yaw: rig.yaw,
      pitch: rig.pitch,
      pitchOffset: THIRD_PERSON.isometricPitch,
      boom: THIRD_PERSON.boom * boomZoomRef.current,
    });
    const anchor = { x: rig.position.x, y: rig.position.y + THIRD_PERSON.lookHeight, z: rig.position.z };
    const { point: resolvedCam } = resolveBoom({ anchor, camera: desired.camera, buildings: buildingList });

    if (!lookInitRef.current) {
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

  if (cameraView !== 'third') return null;
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={null}>
        <PlayerAvatar rigRef={rigRef} />
      </Suspense>
    </ErrorBoundary>
  );
}
