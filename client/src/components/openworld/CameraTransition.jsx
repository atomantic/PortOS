import { useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { smoothstep } from '../../utils/easing';
import { DEFAULT_SPAWN_Z, EYE_HEIGHT, THIRD_PERSON, thirdPersonCamera } from '../../utils/openWorldPlayerRig';

const ORBITAL_POS = new THREE.Vector3(0, 25, 45);
const ORBITAL_TARGET = new THREE.Vector3(0, 0, 0);
const DEFAULT_EXPLORATION_RIG = { x: 0, y: EYE_HEIGHT, z: DEFAULT_SPAWN_Z };
const DEFAULT_EXPLORATION_FRAME = thirdPersonCamera({
  pos: DEFAULT_EXPLORATION_RIG,
  yaw: THIRD_PERSON.isometricYaw,
  pitch: 0,
  pitchOffset: THIRD_PERSON.isometricPitch,
});
const DEFAULT_EXPLORATION_POS = new THREE.Vector3(
  DEFAULT_EXPLORATION_FRAME.camera.x,
  DEFAULT_EXPLORATION_FRAME.camera.y,
  DEFAULT_EXPLORATION_FRAME.camera.z,
);
const DEFAULT_EXPLORATION_TARGET = new THREE.Vector3(
  DEFAULT_EXPLORATION_FRAME.lookAt.x,
  DEFAULT_EXPLORATION_FRAME.lookAt.y,
  DEFAULT_EXPLORATION_FRAME.lookAt.z,
);
const DURATION = 0.8;

export default function CameraTransition({ active, targetPos, targetLookAt, onTransitionComplete }) {
  const { camera } = useThree();
  const progressRef = useRef(0);
  const startPosRef = useRef(new THREE.Vector3());
  const startTargetRef = useRef(new THREE.Vector3());
  // The player controller already owns the initial exploration camera. Starting a
  // transition from the Canvas' orbital camera makes the world visibly sweep past
  // the player on load, and on a phone that can leave the first frame aimed at the
  // sky. Only animate when the user actually changes modes after mount.
  const wasActiveRef = useRef(active);
  const completedRef = useRef(true);

  useFrame((_, delta) => {
    // Detect transition start
    if (active !== wasActiveRef.current) {
      wasActiveRef.current = active;
      progressRef.current = 0;
      completedRef.current = false;
      startPosRef.current.copy(camera.position);
      // Approximate current look-at from camera direction
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      startTargetRef.current.copy(camera.position).add(dir.multiplyScalar(10));
    }

    if (completedRef.current) return;

    progressRef.current += delta / DURATION;
    if (progressRef.current >= 1) {
      progressRef.current = 1;
      completedRef.current = true;
    }

    const t = smoothstep(Math.min(progressRef.current, 1));

    // Match the elevated diagonal exploration framing while the player rig takes over.
    // The transition target is only a short hand-off; PlayerController then tracks the
    // actual rover position and applies the same isometric offset every frame.
    const endPos = active ? (targetPos || DEFAULT_EXPLORATION_POS) : ORBITAL_POS;
    const endTarget = active ? (targetLookAt || DEFAULT_EXPLORATION_TARGET) : ORBITAL_TARGET;

    camera.position.lerpVectors(startPosRef.current, endPos, t);

    const currentTarget = new THREE.Vector3().lerpVectors(startTargetRef.current, endTarget, t);
    camera.lookAt(currentTarget);

    if (completedRef.current) {
      onTransitionComplete?.();
    }
  });

  return null;
}
