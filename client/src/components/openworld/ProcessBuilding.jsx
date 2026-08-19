import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PROCESS_BUILDING_PARAMS, mixHex } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';

// Process status → color, unified with the themed building map (so 'online' follows
// the active theme accent and the semantic colors match a stopped/missing *app*):
// 'stopped' is the same red as a stopped app (was amber), 'not_found' the same purple
// (was indigo). PM2's hard-failure states ("errored"; some legacy callers send "error")
// read as the same red as stopped — both mean "down".
const getProcessColor = (status, building) => {
  switch (status) {
    case 'online': return building.online;
    case 'stopped':
    case 'errored':
    case 'error': return building.stopped;
    case 'not_found':
    default: return building.not_found;
  }
};

export default function ProcessBuilding({ pm2Status, position, seed, dimmed = false, dayMix = 0 }) {
  const { building, buildingBody, surface } = useOpenWorldPalette();
  const blinkRef = useRef();
  const glowRef = useRef();
  const ringRef = useRef();

  const status = pm2Status?.status || 'not_found';
  const color = getProcessColor(status, building);
  const { width, depth } = PROCESS_BUILDING_PARAMS;
  const radius = Math.max(width, depth) * 0.58;
  const dimMul = dimmed ? 0.25 : 1;
  // Match the main Building's daytime treatment — sheds neon, lightens to a lit solid.
  const bodyColor = mixHex(buildingBody, mixHex('#9aa0ac', color, 0.12), dayMix);
  const neonFade = 1 - dayMix;

  // Height based on status + seed variation
  const height = useMemo(() => {
    if (status === 'online') {
      return 2.0 + (seed % 100) / 100 * 1.5; // 2.0 - 3.5
    }
    return 1.5;
  }, [status, seed]);

  const bodyGeom = useMemo(() => new THREE.CylinderGeometry(radius * 0.82, radius, height, 6), [radius, height]);
  const edgesGeom = useMemo(() => new THREE.EdgesGeometry(bodyGeom), [bodyGeom]);

  // edgesGeom is handed to <lineSegments> via a `geometry` prop, so R3F does not
  // manage its disposal the way it would a JSX <edgesGeometry> child. `height`
  // (and thus this geometry) is keyed on `status` — an online process is taller
  // than a stopped/errored one — so every status flip would otherwise strand the
  // previous geometry's GPU buffers, same leak class as Building.jsx's windowTexture.
  useEffect(() => {
    return () => {
      bodyGeom.dispose();
      edgesGeom.dispose();
    };
  }, [bodyGeom, edgesGeom]);

  // Rotation to face center (passed via position array)
  const rotation = position[3] || 0;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (blinkRef.current) {
      blinkRef.current.material.opacity = ((Math.sin(t * 3 + seed) > 0.3) ? 0.8 : 0.1) * dimMul * neonFade;
    }
    if (glowRef.current) {
      const base = status === 'online'
        ? 0.15 + Math.sin(t * 1.5 + seed) * 0.08
        : 0.08;
      glowRef.current.material.opacity = base * dimMul * neonFade;
    }
    if (ringRef.current) ringRef.current.rotation.z = t * 0.45 + seed;
  });

  return (
    <group position={[position[0], 0, position[2]]} rotation={[0, rotation, 0]}>
      {/* Hexagonal process pylon: a readable status token rather than a second tiny building. */}
      <mesh position={[0, height / 2, 0]} geometry={bodyGeom}>
        <meshStandardMaterial
          {...surface}
          color={bodyColor}
          emissive={color}
          emissiveIntensity={(status === 'online' ? 0.2 : 0.08) * dimMul * (1 - dayMix * 0.9)}
          roughness={dayMix > 0.5 ? 0.9 : 1}
          transparent
          opacity={0.9 * dimMul}
        />
      </mesh>

      {/* Neon wireframe edges (soften to a plain outline by day) */}
      <lineSegments position={[0, height / 2, 0]} geometry={edgesGeom}>
        <lineBasicMaterial color={dayMix > 0.5 ? mixHex('#4a4f57', color, 0.15) : color} transparent opacity={(0.8 - dayMix * 0.55) * dimMul} />
      </lineSegments>

      {/* Neon top cap */}
      <mesh position={[0, height + 0.01, 0]}>
        <cylinderGeometry args={[radius * 0.86, radius * 0.86, 0.05, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.4 * dimMul * (1 - dayMix * 0.6)} />
      </mesh>

      {/* A quiet rotating ring makes the pylon readable at a glance while keeping labels
          reserved for the focused main building. */}
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.09, 0]}>
        <torusGeometry args={[radius * 0.78, 0.014, 6, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.42 * dimMul * (0.35 + neonFade * 0.65)} />
      </mesh>

      {/* Blinking tip light */}
      <mesh ref={blinkRef} position={[0, height + 0.12, 0]}>
        <sphereGeometry args={[0.03, 6, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.8 * dimMul} />
      </mesh>

      {/* Base glow circle */}
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.6, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.15 * dimMul} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
