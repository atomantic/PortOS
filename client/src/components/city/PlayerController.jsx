import { useRef, useEffect, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import PlayerAvatar from './PlayerAvatar';

const WALK_SPEED = 8;
const SPRINT_SPEED = 14;
const CAMERA_DISTANCE = 5;
const CAMERA_LERP = 0.08;
const BUILDING_EXCLUSION_RADIUS = 3.5;
const PROXIMITY_DISTANCE = 6;
const WORLD_BOUND = 55;
const HEAD_HEIGHT = 1.4;

export default function PlayerController({
  keysRef,
  positions,
  onBuildingProximity,
  onBuildingClick,
  apps,
  active,
}) {
  const { camera, gl } = useThree();
  const playerPos = useRef(new THREE.Vector3(0, 0, 0));
  const yawRef = useRef(Math.PI); // Facing toward city center
  const pitchRef = useRef(0.3);
  const isMovingRef = useRef(false);
  const facingAngleRef = useRef(Math.PI);
  const lastSpawnRef = useRef(null);
  const pointerLockedRef = useRef(false);
  const proximityAppRef = useRef(null);
  const avatarGroupRef = useRef();

  // Initialize spawn position
  useEffect(() => {
    if (!active) return;
    if (lastSpawnRef.current) {
      playerPos.current.copy(lastSpawnRef.current);
    } else {
      // Spawn behind front row, facing downtown
      let maxZ = 0;
      positions?.forEach((pos) => {
        if (pos.z > maxZ) maxZ = pos.z;
      });
      playerPos.current.set(0, 0, maxZ + 8);
      yawRef.current = Math.PI;
    }
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
    yawRef.current -= e.movementX * 0.002;
    pitchRef.current += e.movementY * 0.002;
    pitchRef.current = Math.max(-0.4, Math.min(1.2, pitchRef.current));
  }, [active]);

  useEffect(() => {
    if (!active) {
      // Release pointer lock when leaving exploration mode
      if (document.pointerLockElement === gl.domElement) {
        document.exitPointerLock?.();
      }
      // Save last position for re-entry
      lastSpawnRef.current = playerPos.current.clone();
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

  // E key for building interaction
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e) => {
      if (e.key.toLowerCase() === 'e' && proximityAppRef.current) {
        onBuildingClick?.(proximityAppRef.current);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onBuildingClick]);

  useFrame((_, delta) => {
    if (!active) return;

    const keys = keysRef.current;
    const isSprinting = keys.has('shift');
    const speed = (isSprinting ? SPRINT_SPEED : WALK_SPEED) * delta;

    // Movement direction relative to camera yaw
    const forward = new THREE.Vector3(-Math.sin(yawRef.current), 0, -Math.cos(yawRef.current));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    const moveDir = new THREE.Vector3(0, 0, 0);
    if (keys.has('w') || keys.has('arrowup')) moveDir.add(forward);
    if (keys.has('s') || keys.has('arrowdown')) moveDir.sub(forward);
    if (keys.has('a') || keys.has('arrowleft')) moveDir.sub(right);
    if (keys.has('d') || keys.has('arrowright')) moveDir.add(right);

    const moving = moveDir.lengthSq() > 0;
    isMovingRef.current = moving;

    if (moving) {
      moveDir.normalize().multiplyScalar(speed);
      const nextPos = playerPos.current.clone().add(moveDir);
      nextPos.y = 0;

      // Update facing angle to movement direction
      facingAngleRef.current = Math.atan2(moveDir.x, moveDir.z);

      // Collision detection with buildings
      let blocked = false;
      positions?.forEach((pos) => {
        const dx = nextPos.x - pos.x;
        const dz = nextPos.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < BUILDING_EXCLUSION_RADIUS) {
          // Slide along boundary tangent
          const nx = dx / dist;
          const nz = dz / dist;
          const dot = moveDir.x * nx + moveDir.z * nz;
          if (dot < 0) {
            // Moving toward building - project movement onto tangent
            nextPos.x = playerPos.current.x + (moveDir.x - dot * nx) * 0.8;
            nextPos.z = playerPos.current.z + (moveDir.z - dot * nz) * 0.8;
            // Re-check distance after slide
            const dx2 = nextPos.x - pos.x;
            const dz2 = nextPos.z - pos.z;
            if (Math.sqrt(dx2 * dx2 + dz2 * dz2) < BUILDING_EXCLUSION_RADIUS) {
              blocked = true;
            }
          }
        }
      });

      if (!blocked) {
        // World bounds
        nextPos.x = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, nextPos.x));
        nextPos.z = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, nextPos.z));
        playerPos.current.copy(nextPos);
      }
    }

    // Building proximity detection
    let nearestApp = null;
    let nearestDist = PROXIMITY_DISTANCE;
    positions?.forEach((pos, appId) => {
      const dx = playerPos.current.x - pos.x;
      const dz = playerPos.current.z - pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
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

    // Camera follow - spherical offset from player
    const camX = playerPos.current.x + Math.sin(yawRef.current) * Math.cos(pitchRef.current) * CAMERA_DISTANCE;
    const camY = playerPos.current.y + HEAD_HEIGHT + Math.sin(pitchRef.current) * CAMERA_DISTANCE;
    const camZ = playerPos.current.z + Math.cos(yawRef.current) * Math.cos(pitchRef.current) * CAMERA_DISTANCE;

    const targetCamPos = new THREE.Vector3(camX, camY, camZ);
    camera.position.lerp(targetCamPos, CAMERA_LERP);

    const lookTarget = new THREE.Vector3(
      playerPos.current.x,
      playerPos.current.y + HEAD_HEIGHT,
      playerPos.current.z,
    );
    camera.lookAt(lookTarget);

    // Update avatar position
    if (avatarGroupRef.current) {
      avatarGroupRef.current.position.set(
        playerPos.current.x,
        playerPos.current.y,
        playerPos.current.z,
      );
    }
  });

  if (!active) return null;

  return (
    <group ref={avatarGroupRef}>
      <PlayerAvatar
        isMoving={isMovingRef.current}
        facingAngle={facingAngleRef.current}
      />
    </group>
  );
}
