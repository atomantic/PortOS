import { useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const ORBITAL_POS = new THREE.Vector3(0, 25, 45);
const ORBITAL_TARGET = new THREE.Vector3(0, 0, 0);
const DURATION = 0.8;

// Smoothstep easing
const smoothstep = (t) => t * t * (3 - 2 * t);

export default function CameraTransition({ active, targetPos, targetLookAt, onTransitionComplete }) {
  const { camera } = useThree();
  const progressRef = useRef(0);
  const startPosRef = useRef(new THREE.Vector3());
  const startTargetRef = useRef(new THREE.Vector3());
  const wasActiveRef = useRef(false);
  const completedRef = useRef(false);

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

    const endPos = active ? (targetPos || new THREE.Vector3(0, 2, 15)) : ORBITAL_POS;
    const endTarget = active ? (targetLookAt || new THREE.Vector3(0, 1.4, 10)) : ORBITAL_TARGET;

    camera.position.lerpVectors(startPosRef.current, endPos, t);

    const currentTarget = new THREE.Vector3().lerpVectors(startTargetRef.current, endTarget, t);
    camera.lookAt(currentTarget);

    if (completedRef.current) {
      onTransitionComplete?.();
    }
  });

  return null;
}
