import { useRef, useEffect, useCallback } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const WALK_SPEED = 10;
const SPRINT_SPEED = 20;
const VERTICAL_SPEED = 8;
const BUILDING_EXCLUSION_RADIUS = 3.5;
const PROXIMITY_DISTANCE = 6;
const WORLD_BOUND = 180;
const EYE_HEIGHT = 1.6;
const MAX_CAMERA_HEIGHT = 160;
const BUILDING_FLYOVER_HEIGHT = 12; // above this the player clears rooftops, so skip collision
const MOUSE_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI / 2 - 0.02;

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
  const yawRef = useRef(0); // Facing toward city center (-Z direction)
  const pitchRef = useRef(0);
  const lastSpawnRef = useRef(null);
  const pointerLockedRef = useRef(false);
  const proximityAppRef = useRef(null);

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
      playerPos.current.set(0, EYE_HEIGHT, maxZ + 8);
      yawRef.current = 0; // Forward = (0, 0, -1), facing toward city center
      pitchRef.current = 0;
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
    yawRef.current -= e.movementX * MOUSE_SENSITIVITY;
    pitchRef.current -= e.movementY * MOUSE_SENSITIVITY;
    pitchRef.current = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitchRef.current));
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

  // F key for building interaction. E is vertical up in free-look controls.
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e) => {
      if (e.key.toLowerCase() === 'f' && proximityAppRef.current) {
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
    const verticalSpeed = (isSprinting ? SPRINT_SPEED : VERTICAL_SPEED) * delta;

    // Movement direction relative to camera yaw
    const forward = new THREE.Vector3(-Math.sin(yawRef.current), 0, -Math.cos(yawRef.current));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    const moveDir = new THREE.Vector3(0, 0, 0);
    if (keys.has('w') || keys.has('arrowup')) moveDir.add(forward);
    if (keys.has('s') || keys.has('arrowdown')) moveDir.sub(forward);
    if (keys.has('a') || keys.has('arrowleft')) moveDir.sub(right);
    if (keys.has('d') || keys.has('arrowright')) moveDir.add(right);

    const hasHorizontal = moveDir.lengthSq() > 0;
    const verticalDir = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
    const moving = hasHorizontal || verticalDir !== 0;

    if (moving) {
      if (hasHorizontal) moveDir.normalize().multiplyScalar(speed);
      const nextPos = playerPos.current.clone().add(moveDir);
      nextPos.y += verticalDir * verticalSpeed;

      // Collision detection with buildings — skipped above rooftop height so the
      // player can fly over the city.
      let blocked = false;
      if (hasHorizontal && nextPos.y < BUILDING_FLYOVER_HEIGHT) {
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
      }

      if (!blocked) {
        // World bounds
        nextPos.x = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, nextPos.x));
        nextPos.y = Math.max(EYE_HEIGHT, Math.min(MAX_CAMERA_HEIGHT, nextPos.y));
        nextPos.z = Math.max(-WORLD_BOUND, Math.min(WORLD_BOUND, nextPos.z));
        playerPos.current.copy(nextPos);
      }
    }

    // Building proximity detection
    let nearestApp = null;
    let nearestDist = PROXIMITY_DISTANCE;
    positions?.forEach((pos, appId) => {
      const dx = playerPos.current.x - pos.x;
      const dy = playerPos.current.y - ((pos.height ?? 4) * 0.5);
      const dz = playerPos.current.z - pos.z;
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

    camera.position.copy(playerPos.current);
    const lookDir = new THREE.Vector3(
      -Math.sin(yawRef.current) * Math.cos(pitchRef.current),
      Math.sin(pitchRef.current),
      -Math.cos(yawRef.current) * Math.cos(pitchRef.current),
    );
    const lookTarget = playerPos.current.clone().add(lookDir);
    camera.lookAt(lookTarget);
  });

  if (!active) return null;

  return null;
}
