import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const HOLOGRAM_TYPES = ['diamond', 'invertedPyramid', 'saturn', 'rings', 'cube', 'beacon'];

function HoloDiamond({ color }) {
  const geom = useMemo(() => new THREE.OctahedronGeometry(0.5, 0), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geom), [geom]);
  return (
    <group>
      <mesh geometry={geom}>
        <meshBasicMaterial color={color} transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={color} transparent opacity={0.85} />
      </lineSegments>
    </group>
  );
}

function HoloPyramid({ color }) {
  const geom = useMemo(() => new THREE.ConeGeometry(0.5, 0.8, 4), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geom), [geom]);
  return (
    <group rotation={[Math.PI, 0, Math.PI / 4]}>
      <mesh geometry={geom}>
        <meshBasicMaterial color={color} transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={color} transparent opacity={0.85} />
      </lineSegments>
    </group>
  );
}

function HoloSaturn({ color }) {
  const sphereGeom = useMemo(() => new THREE.IcosahedronGeometry(0.25, 1), []);
  const ringGeom = useMemo(() => new THREE.TorusGeometry(0.5, 0.025, 8, 32), []);
  const sphereEdges = useMemo(() => new THREE.EdgesGeometry(sphereGeom), [sphereGeom]);
  return (
    <group>
      <mesh geometry={sphereGeom}>
        <meshBasicMaterial color={color} transparent opacity={0.15} />
      </mesh>
      <lineSegments geometry={sphereEdges}>
        <lineBasicMaterial color={color} transparent opacity={0.7} />
      </lineSegments>
      <mesh geometry={ringGeom} rotation={[Math.PI / 3, 0.3, 0]}>
        <meshBasicMaterial color={color} transparent opacity={0.35} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function HoloRings({ color }) {
  const geoms = useMemo(() => [
    new THREE.TorusGeometry(0.45, 0.02, 8, 24),
    new THREE.TorusGeometry(0.3, 0.02, 8, 24),
    new THREE.TorusGeometry(0.38, 0.02, 8, 24),
  ], []);
  return (
    <group>
      {geoms.map((geom, i) => (
        <mesh key={i} geometry={geom} position={[0, (i - 1) * 0.22, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color={color} transparent opacity={0.45 + i * 0.15} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

function HoloCube({ color }) {
  const geom = useMemo(() => new THREE.BoxGeometry(0.45, 0.45, 0.45), []);
  const edges = useMemo(() => new THREE.EdgesGeometry(geom), [geom]);
  return (
    <group rotation={[Math.PI / 6, Math.PI / 4, 0]}>
      <mesh geometry={geom}>
        <meshBasicMaterial color={color} transparent opacity={0.08} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={color} transparent opacity={0.85} />
      </lineSegments>
    </group>
  );
}

function HoloBeacon({ color }) {
  const cylGeom = useMemo(() => new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6), []);
  const sphereGeom = useMemo(() => new THREE.SphereGeometry(0.15, 8, 8), []);
  return (
    <group>
      <mesh geometry={cylGeom}>
        <meshBasicMaterial color={color} transparent opacity={0.5} />
      </mesh>
      <mesh geometry={sphereGeom} position={[0, 0.32, 0]}>
        <meshBasicMaterial color={color} transparent opacity={0.75} />
      </mesh>
    </group>
  );
}

const SHAPES = {
  diamond: HoloDiamond,
  invertedPyramid: HoloPyramid,
  saturn: HoloSaturn,
  rings: HoloRings,
  cube: HoloCube,
  beacon: HoloBeacon,
};

export default function BuildingHologram({ position, color, seed }) {
  const bobRef = useRef();
  const spinRef = useRef();
  const glowRef = useRef();

  const type = HOLOGRAM_TYPES[seed % HOLOGRAM_TYPES.length];
  const Shape = SHAPES[type];

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (bobRef.current) {
      bobRef.current.position.y = Math.sin(t * 1.0 + seed * 0.7) * 0.15;
    }
    if (spinRef.current) {
      spinRef.current.rotation.y = t * 0.4 + seed;
    }
    if (glowRef.current) {
      glowRef.current.opacity = 0.15 + Math.sin(t * 1.5 + seed) * 0.08;
    }
  });

  return (
    <group position={position}>
      {/* Projector base disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]}>
        <circleGeometry args={[0.5, 16]} />
        <meshBasicMaterial ref={glowRef} color={color} transparent opacity={0.15} side={THREE.DoubleSide} />
      </mesh>
      {/* Animated hologram shape */}
      <group ref={bobRef}>
        <group ref={spinRef}>
          <Shape color={color} />
        </group>
      </group>
      {/* Subtle point light glow */}
      <pointLight color={color} intensity={0.5} distance={4} decay={2} />
    </group>
  );
}
