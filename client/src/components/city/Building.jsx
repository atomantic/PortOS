import { useRef, useState, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getBuildingColor, getBuildingHeight, CITY_COLORS } from './cityConstants';
import HolographicPanel from './HolographicPanel';

export default function Building({ app, position, agentCount, onClick }) {
  const meshRef = useRef();
  const edgesRef = useRef();
  const glowRef = useRef();
  const [hovered, setHovered] = useState(false);

  const height = getBuildingHeight(app);
  const edgeColor = getBuildingColor(app.overallStatus, app.archived);
  const isOnline = app.overallStatus === 'online' && !app.archived;

  const boxGeom = useMemo(() => new THREE.BoxGeometry(1.5, height, 1.5), [height]);
  const edgesGeom = useMemo(() => new THREE.EdgesGeometry(boxGeom), [boxGeom]);

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();

    // Emissive pulse on hover or when online
    const baseIntensity = isOnline ? 0.15 : 0.05;
    const pulse = isOnline ? Math.sin(t * 2) * 0.05 : 0;
    const hoverBoost = hovered ? 0.2 : 0;
    meshRef.current.material.emissiveIntensity = baseIntensity + pulse + hoverBoost;

    // Ground glow pulse
    if (glowRef.current) {
      glowRef.current.material.opacity = 0.15 + (isOnline ? Math.sin(t * 1.5) * 0.05 : 0) + (hovered ? 0.1 : 0);
    }
  });

  return (
    <group position={[position.x, 0, position.z]}>
      {/* Building body */}
      <mesh
        ref={meshRef}
        position={[0, height / 2, 0]}
        onClick={onClick}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <boxGeometry args={[1.5, height, 1.5]} />
        <meshStandardMaterial
          color={CITY_COLORS.buildingBody}
          emissive={edgeColor}
          emissiveIntensity={0.1}
          transparent
          opacity={app.archived ? 0.6 : 0.9}
        />
      </mesh>

      {/* Neon wireframe edges */}
      <lineSegments
        ref={edgesRef}
        position={[0, height / 2, 0]}
        geometry={edgesGeom}
      >
        <lineBasicMaterial
          color={edgeColor}
          transparent
          opacity={app.archived ? 0.3 : 0.8}
        />
      </lineSegments>

      {/* Base glow circle */}
      <mesh ref={glowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <circleGeometry args={[1.2, 32]} />
        <meshBasicMaterial
          color={edgeColor}
          transparent
          opacity={0.15}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Holographic label - show on hover or always for online */}
      {(hovered || isOnline) && (
        <HolographicPanel
          app={app}
          agentCount={agentCount}
          position={[0, height + 0.8, 0]}
        />
      )}
    </group>
  );
}
