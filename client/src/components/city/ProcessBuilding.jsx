import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import { CITY_COLORS, PROCESS_BUILDING_PARAMS, PIXEL_FONT_URL } from './cityConstants';

const STATUS_COLORS = {
  online: '#06b6d4',
  stopped: '#f59e0b',
  not_found: '#6366f1',
  error: '#ef4444',
};

const hashString = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

export default function ProcessBuilding({ process, pm2Status, position, accentColor, seed }) {
  const blinkRef = useRef();
  const glowRef = useRef();

  const status = pm2Status?.status || 'not_found';
  const color = STATUS_COLORS[status] || STATUS_COLORS.not_found;
  const { width, depth } = PROCESS_BUILDING_PARAMS;

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
      blinkRef.current.material.opacity = (Math.sin(t * 3 + seed) > 0.3) ? 0.8 : 0.1;
    }
    if (glowRef.current) {
      glowRef.current.material.opacity = status === 'online'
        ? 0.15 + Math.sin(t * 1.5 + seed) * 0.08
        : 0.08;
    }
  });

  return (
    <group position={[position[0], 0, position[2]]} rotation={[0, rotation, 0]}>
      {/* Building body */}
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial
          color={CITY_COLORS.buildingBody}
          emissive={color}
          emissiveIntensity={status === 'online' ? 0.2 : 0.08}
          transparent
          opacity={0.9}
        />
      </mesh>

      {/* Neon wireframe edges */}
      <lineSegments position={[0, height / 2, 0]} geometry={edgesGeom}>
        <lineBasicMaterial color={color} transparent opacity={0.8} />
      </lineSegments>

      {/* Neon top cap */}
      <mesh position={[0, height + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width + 0.05, depth + 0.05]} />
        <meshBasicMaterial color={color} transparent opacity={0.4} />
      </mesh>

      {/* Process name on front face */}
      <Text
        position={[0, height * 0.7, depth / 2 + 0.02]}
        fontSize={0.1}
        color={color}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
        maxWidth={width * 0.85}
      >
        {displayName}
      </Text>

      {/* Blinking tip light */}
      <mesh ref={blinkRef} position={[0, height + 0.12, 0]}>
        <sphereGeometry args={[0.03, 6, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} />
      </mesh>

      {/* Base glow circle */}
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[0.6, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.15} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
