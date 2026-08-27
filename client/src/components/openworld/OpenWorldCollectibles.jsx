import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getCollectiblesList } from '../../utils/openWorldCollectibles';

function ShardMesh({ shard, animate }) {
  const meshRef = useRef();
  const coreRef = useRef();
  const ringRef = useRef();
  const outerRingRef = useRef();
  const { color, x, y, z, pulsePhase } = shard;

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();
    if (animate) {
      meshRef.current.rotation.y = t * 1.6 + pulsePhase * Math.PI;
      meshRef.current.rotation.x = Math.sin(t * 1.2 + pulsePhase) * 0.15;
      meshRef.current.position.y = y + Math.sin(t * 2.4 + pulsePhase * Math.PI * 2) * 0.22;
      if (coreRef.current) {
        coreRef.current.rotation.y = -t * 2.2;
        coreRef.current.rotation.z = Math.cos(t * 1.5) * 0.2;
        coreRef.current.position.y = meshRef.current.position.y;
      }
      if (ringRef.current) {
        ringRef.current.rotation.z = t * 0.8;
        ringRef.current.scale.setScalar(1 + Math.sin(t * 3 + pulsePhase) * 0.1);
      }
      if (outerRingRef.current) {
        outerRingRef.current.rotation.z = -t * 0.5;
        outerRingRef.current.scale.setScalar(1 + Math.cos(t * 2.5 + pulsePhase) * 0.08);
      }
    }
  });

  return (
    <group position={[x, 0, z]}>
      {/* Outer crystal facet */}
      <mesh ref={meshRef} position={[0, y, 0]}>
        <octahedronGeometry args={[0.55, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.2}
          metalness={0.85}
          roughness={0.12}
          transparent
          opacity={0.92}
          toneMapped={false}
        />
      </mesh>

      {/* Inner glowing white-hot core */}
      <mesh ref={coreRef} position={[0, y, 0]} scale={0.36}>
        <octahedronGeometry args={[0.55, 0]} />
        <meshBasicMaterial
          color="#ffffff"
          toneMapped={false}
        />
      </mesh>

      {/* Inner ground energy ring */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <ringGeometry args={[0.55, 0.68, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.4}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Outer faint shimmer halo ring */}
      <mesh ref={outerRingRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
        <ringGeometry args={[0.75, 0.88, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.18}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

function CollectionBurst({ burst }) {
  const groupRef = useRef();

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    burst.age += delta;
    const progress = Math.min(1, burst.age / 0.8);
    const scale = 1 + progress * 2.8;
    groupRef.current.scale.set(scale, scale, scale);
    groupRef.current.position.y = burst.y + progress * 1.5;
    if (groupRef.current.children[0]?.material) {
      groupRef.current.children[0].material.opacity = Math.max(0, 1 - progress);
    }
  });

  if (burst.age >= 0.8) return null;

  return (
    <group ref={groupRef} position={[burst.x, burst.y, burst.z]}>
      <mesh>
        <sphereGeometry args={[0.4, 8, 8]} />
        <meshBasicMaterial
          color={burst.color || '#06b6d4'}
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

export default function OpenWorldCollectibles({
  collectedShardIds = new Set(),
  activeBursts = [],
  settings,
  shards,
}) {
  const resolvedShards = useMemo(() => shards || getCollectiblesList(), [shards]);
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const visibleShards = useMemo(
    () => resolvedShards.filter((s) => !collectedShardIds.has(s.id)),
    [resolvedShards, collectedShardIds]
  );

  return (
    <group>
      {visibleShards.map((shard) => (
        <ShardMesh
          key={shard.id}
          shard={shard}
          animate={animate}
        />
      ))}
      {activeBursts.map((burst) => (
        <CollectionBurst key={burst.id} burst={burst} />
      ))}
    </group>
  );
}
