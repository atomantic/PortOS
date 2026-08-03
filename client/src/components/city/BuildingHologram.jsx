import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const HOLOGRAM_TYPES = ['diamond', 'invertedPyramid', 'saturn', 'rings', 'cube', 'beacon'];

// Every Holo* shape's geometry below has fixed parameters — `color`/`seed` only
// drive material/animation, never geometry — so each is a module-scope singleton
// shared by every hologram instance, mirroring Building.jsx's ROOF_GEOMS pattern.
// A per-instance useMemo would otherwise allocate fresh, never-disposed GPU
// geometry on every mount, and holograms mount/unmount on every dim/undim.
const DIAMOND_GEOM = new THREE.OctahedronGeometry(0.5, 0);
const DIAMOND_EDGES = new THREE.EdgesGeometry(DIAMOND_GEOM);

const PYRAMID_GEOM = new THREE.ConeGeometry(0.5, 0.8, 4);
const PYRAMID_EDGES = new THREE.EdgesGeometry(PYRAMID_GEOM);

const SATURN_SPHERE_GEOM = new THREE.IcosahedronGeometry(0.25, 1);
const SATURN_RING_GEOM = new THREE.TorusGeometry(0.5, 0.025, 8, 32);
const SATURN_SPHERE_EDGES = new THREE.EdgesGeometry(SATURN_SPHERE_GEOM);

const RINGS_GEOMS = [
  new THREE.TorusGeometry(0.45, 0.02, 8, 24),
  new THREE.TorusGeometry(0.3, 0.02, 8, 24),
  new THREE.TorusGeometry(0.38, 0.02, 8, 24),
];

const CUBE_GEOM = new THREE.BoxGeometry(0.45, 0.45, 0.45);
const CUBE_EDGES = new THREE.EdgesGeometry(CUBE_GEOM);

const BEACON_CYL_GEOM = new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6);
const BEACON_SPHERE_GEOM = new THREE.SphereGeometry(0.15, 8, 8);

function HoloDiamond({ color }) {
  return (
    <group>
      <mesh geometry={DIAMOND_GEOM}>
        <meshBasicMaterial color={color} transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={DIAMOND_EDGES}>
        <lineBasicMaterial color={color} transparent opacity={0.85} />
      </lineSegments>
    </group>
  );
}

function HoloPyramid({ color }) {
  return (
    <group rotation={[Math.PI, 0, Math.PI / 4]}>
      <mesh geometry={PYRAMID_GEOM}>
        <meshBasicMaterial color={color} transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={PYRAMID_EDGES}>
        <lineBasicMaterial color={color} transparent opacity={0.85} />
      </lineSegments>
    </group>
  );
}

function HoloSaturn({ color }) {
  return (
    <group>
      <mesh geometry={SATURN_SPHERE_GEOM}>
        <meshBasicMaterial color={color} transparent opacity={0.15} />
      </mesh>
      <lineSegments geometry={SATURN_SPHERE_EDGES}>
        <lineBasicMaterial color={color} transparent opacity={0.7} />
      </lineSegments>
      <mesh geometry={SATURN_RING_GEOM} rotation={[Math.PI / 3, 0.3, 0]}>
        <meshBasicMaterial color={color} transparent opacity={0.35} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function HoloRings({ color }) {
  return (
    <group>
      {RINGS_GEOMS.map((geom, i) => (
        <mesh key={i} geometry={geom} position={[0, (i - 1) * 0.22, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color={color} transparent opacity={0.45 + i * 0.15} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

function HoloCube({ color }) {
  return (
    <group rotation={[Math.PI / 6, Math.PI / 4, 0]}>
      <mesh geometry={CUBE_GEOM}>
        <meshBasicMaterial color={color} transparent opacity={0.08} />
      </mesh>
      <lineSegments geometry={CUBE_EDGES}>
        <lineBasicMaterial color={color} transparent opacity={0.85} />
      </lineSegments>
    </group>
  );
}

function HoloBeacon({ color }) {
  return (
    <group>
      <mesh geometry={BEACON_CYL_GEOM}>
        <meshBasicMaterial color={color} transparent opacity={0.5} />
      </mesh>
      <mesh geometry={BEACON_SPHERE_GEOM} position={[0, 0.32, 0]}>
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
