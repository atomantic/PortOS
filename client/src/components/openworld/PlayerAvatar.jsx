import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { dampFactor, EYE_HEIGHT } from '../../utils/openWorldPlayerRig';
import { mixHex } from './openWorldConstants';

// A small, procedural low-poly rover keeps the third-person actor local to OpenWorld.
// It is intentionally made from primitives instead of another downloaded GLB: the car
// inherits the active theme, loads instantly, and stays readable while sprinting, jumping,
// or flying above the city.
const CAR_LENGTH = 1.85;
const CAR_WIDTH = 1.06;
const WHEEL_RADIUS = 0.24;
const WHEEL_X = CAR_WIDTH * 0.57;
const WHEEL_Z = CAR_LENGTH * 0.31;
const _rootTarget = new THREE.Vector3();

export default function PlayerAvatar({ rigRef }) {
  const { accent, surface } = useOpenWorldPalette();
  const rootRef = useRef();
  const bodyRef = useRef();
  const hoverRingRef = useRef();
  const underglowRef = useRef();
  const wheelRefs = useRef([]);

  const bodyColor = mixHex('#ee8f68', accent, 0.16);
  const bodyShadow = mixHex('#263447', accent, 0.16);
  const glassColor = mixHex('#294765', accent, 0.22);
  const wheelColor = '#17212d';

  useFrame(({ clock }, delta) => {
    const root = rootRef.current;
    const body = bodyRef.current;
    const rig = rigRef?.current;
    if (!root || !body || !rig) return;

    const t = clock.getElapsedTime();
    const hovering = rig.state === 'hover';
    const moving = rig.state === 'walk' || rig.state === 'run';
    const running = rig.state === 'run';
    const follow = dampFactor(10, delta);
    const targetY = rig.position.y - EYE_HEIGHT + (hovering ? 0.25 : 0);

    root.position.lerp(_rootTarget.set(rig.position.x, targetY, rig.position.z), follow);
    root.rotation.y = rig.facing;
    root.rotation.z = rig.bank * 0.38;

    const bob = hovering ? 0.2 + Math.sin(t * 2.4) * 0.07 : 0;
    body.position.y += (bob - body.position.y) * follow;
    body.rotation.x = hovering ? Math.sin(t * 2.1) * 0.045 : 0;
    body.rotation.z = rig.bank * 0.32;

    const wheelSpeed = running ? 15 : moving ? 8 : 0;
    wheelRefs.current.forEach((wheel) => {
      if (!wheel) return;
      wheel.rotation.x -= wheelSpeed * delta;
      wheel.rotation.y = hovering ? Math.sin(t * 2) * 0.08 : 0;
    });

    if (hoverRingRef.current) {
      hoverRingRef.current.rotation.z = t * 0.75;
      hoverRingRef.current.material.opacity = hovering ? 0.72 : 0.22;
      hoverRingRef.current.scale.setScalar(hovering ? 1 + Math.sin(t * 3) * 0.08 : 1);
    }
    if (underglowRef.current) {
      underglowRef.current.material.opacity = (hovering ? 0.42 : moving ? 0.26 : 0.16) + Math.sin(t * 4) * 0.025;
    }
  });

  const setWheelRef = (index) => (node) => {
    wheelRefs.current[index] = node;
  };

  return (
    <group ref={rootRef}>
      <group ref={bodyRef}>
        {/* Low-poly body and cabin */}
        <mesh position={[0, 0.48, 0]}>
          <boxGeometry args={[CAR_WIDTH, 0.42, CAR_LENGTH]} />
          <meshStandardMaterial {...surface} color={bodyColor} roughness={0.58} metalness={0.22} />
        </mesh>
        <mesh position={[0, 0.74, 0.08]}>
          <boxGeometry args={[CAR_WIDTH * 0.72, 0.26, CAR_LENGTH * 0.46]} />
          <meshStandardMaterial {...surface} color={glassColor} roughness={0.24} metalness={0.36} transparent opacity={0.92} />
        </mesh>
        <mesh position={[0, 0.39, -CAR_LENGTH * 0.53]}>
          <boxGeometry args={[CAR_WIDTH * 0.88, 0.08, 0.1]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.45} />
        </mesh>
        <mesh position={[0, 0.4, CAR_LENGTH * 0.53]}>
          <boxGeometry args={[CAR_WIDTH * 0.82, 0.07, 0.08]} />
          <meshStandardMaterial color="#ef5252" emissive="#ef5252" emissiveIntensity={0.28} />
        </mesh>

        {/* Front lamps and the small roof beacon make the vehicle readable in both views. */}
        {[-1, 1].map((side) => (
          <mesh key={`lamp-${side}`} position={[side * CAR_WIDTH * 0.3, 0.55, -CAR_LENGTH * 0.53]}>
            <boxGeometry args={[0.13, 0.08, 0.035]} />
            <meshBasicMaterial color="#fff5cf" toneMapped={false} />
          </mesh>
        ))}
        <mesh position={[0, 0.96, 0.08]}>
          <sphereGeometry args={[0.055, 8, 6]} />
          <meshBasicMaterial color={accent} toneMapped={false} />
        </mesh>

        {/* Wheels are deliberately chunky: the actor should read as a vehicle at a glance. */}
        {[
          [-WHEEL_X, WHEEL_Z],
          [WHEEL_X, WHEEL_Z],
          [-WHEEL_X, -WHEEL_Z],
          [WHEEL_X, -WHEEL_Z],
        ].map(([x, z], index) => (
          <group key={`wheel-${index}`} ref={setWheelRef(index)} position={[x, WHEEL_RADIUS, z]} rotation={[0, 0, Math.PI / 2]}>
            <mesh>
              <cylinderGeometry args={[WHEEL_RADIUS, WHEEL_RADIUS, 0.16, 12]} />
              <meshStandardMaterial color={wheelColor} roughness={0.88} metalness={0.08} />
            </mesh>
            <mesh rotation={[0, Math.PI / 2, 0]}>
              <cylinderGeometry args={[WHEEL_RADIUS * 0.44, WHEEL_RADIUS * 0.44, 0.17, 10]} />
              <meshStandardMaterial color={bodyShadow} roughness={0.48} metalness={0.4} />
            </mesh>
          </group>
        ))}
      </group>

      {/* Ground feedback is intentionally simpler than the old robot's large footprint. */}
      <mesh ref={underglowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <circleGeometry args={[0.9, 24]} />
        <meshBasicMaterial color={accent} transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={hoverRingRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <torusGeometry args={[0.82, 0.025, 6, 24]} />
        <meshBasicMaterial color={accent} transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}
