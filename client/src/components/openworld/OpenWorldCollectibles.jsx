import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getCollectiblesList } from '../../utils/openWorldCollectibles';

function ShardMesh({ shard, animate }) {
  const meshRef = useRef();
  const ringRef = useRef();
  const { color, x, y, z, pulsePhase } = shard;

  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();
    if (animate) {
      meshRef.current.rotation.y = t * 1.6 + pulsePhase * Math.PI;
      meshRef.current.rotation.x = Math.sin(t * 1.2 + pulsePhase) * 0.15;
      meshRef.current.position.y = y + Math.sin(t * 2.4 + pulsePhase * Math.PI * 2) * 0.22;
      if (ringRef.current) {
        ringRef.current.rotation.z = t * 0.8;
        ringRef.current.scale.setScalar(1 + Math.sin(t * 3 + pulsePhase) * 0.1);
      }
    }
  });

  return (
    <group position={[x, 0, z]}>
      <mesh ref={meshRef} position={[0, y, 0]}>
        <octahedronGeometry args={[0.55, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.4}
          metalness={0.8}
          roughness={0.15}
          toneMapped={false}
        />
      </mesh>

      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <ringGeometry args={[0.6, 0.72, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.35}
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
}) {
  const shards = useMemo(() => getCollectiblesList(), []);
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const visibleShards = useMemo(
    () => shards.filter((s) => !collectedShardIds.has(s.id)),
    [shards, collectedShardIds]
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
