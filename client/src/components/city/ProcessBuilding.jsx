import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CITY_COLORS, PROCESS_BUILDING_PARAMS, PIXEL_FONT_URL, mixHex } from './cityConstants';
import CityLabel from './CityLabel';

// Process status → color, unified with CITY_COLORS.building (read live so 'online'
// follows the active theme accent and the semantic colors match a stopped/missing
// *app*): 'stopped' is the same red as a stopped app (was amber), 'not_found' the
// same purple (was indigo). PM2's hard-failure states ("errored"; some legacy
// callers send "error") read as the same red as stopped — both mean "down".
const getProcessColor = (status) => {
  const b = CITY_COLORS.building;
  switch (status) {
    case 'online': return b.online;
    case 'stopped':
    case 'errored':
    case 'error': return b.stopped;
    case 'not_found':
    default: return b.not_found;
  }
};

export default function ProcessBuilding({ process, pm2Status, position, seed, dimmed = false, dayMix = 0 }) {
  const blinkRef = useRef();
  const glowRef = useRef();

  const status = pm2Status?.status || 'not_found';
  const color = getProcessColor(status);
  const { width, depth } = PROCESS_BUILDING_PARAMS;
  const dimMul = dimmed ? 0.25 : 1;
  // Match the main Building's daytime treatment — sheds neon, lightens to a lit solid.
  const bodyColor = mixHex(CITY_COLORS.buildingBody, mixHex('#9aa0ac', color, 0.12), dayMix);
  const neonFade = 1 - dayMix;

  // Height based on status + seed variation
  const height = useMemo(() => {
    if (status === 'online') {
      return 2.0 + (seed % 100) / 100 * 1.5; // 2.0 - 3.5
    }
    return 1.5;
  }, [status, seed]);

  const boxGeom = useMemo(() => new THREE.BoxGeometry(width, height, depth), [width, height, depth]);
  const edgesGeom = useMemo(() => new THREE.EdgesGeometry(boxGeom), [boxGeom]);

  const displayName = useMemo(() => {
    return (process.name || '').replace(/[-_.]/g, ' ').toUpperCase();
  }, [process.name]);

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
  });

  return (
    <group position={[position[0], 0, position[2]]} rotation={[0, rotation, 0]}>
      {/* Building body */}
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial
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
      <mesh position={[0, height + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width + 0.05, depth + 0.05]} />
        <meshBasicMaterial color={color} transparent opacity={0.4 * dimMul * (1 - dayMix * 0.6)} />
      </mesh>

      {/* Process name on front face (dark ink + halo by day) */}
      <CityLabel
        position={[0, height * 0.7, depth / 2 + 0.02]}
        fontSize={0.1}
        color={color}
        dayMix={dayMix}
        fillOpacity={dimMul}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
        maxWidth={width * 0.85}
      >
        {displayName}
      </CityLabel>

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
