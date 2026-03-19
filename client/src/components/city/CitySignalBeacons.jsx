import { useMemo, useRef } from 'react';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PIXEL_FONT_URL } from './cityConstants';

function SignalBeacon({ position, color, label, sublabel, intensity = 1 }) {
  const groupRef = useRef();
  const glowRef = useRef();
  const beamRef = useRef();

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pulse = 0.7 + ((Math.sin(t * (1.5 + intensity)) + 1) / 2) * 0.8 * intensity;

    if (groupRef.current) {
      groupRef.current.position.y = position[1] + Math.sin(t * 0.6 + position[0]) * 0.1;
    }
    if (glowRef.current) {
      glowRef.current.material.opacity = 0.15 * pulse;
      glowRef.current.scale.setScalar(0.9 + pulse * 0.15);
    }
    if (beamRef.current) {
      beamRef.current.material.opacity = Math.min(0.35, 0.08 + pulse * 0.08);
    }
  });

  return (
    <group ref={groupRef} position={position}>
      <mesh ref={beamRef} position={[0, 2.8, 0]}>
        <cylinderGeometry args={[0.08, 0.45, 5.5, 12, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[0.35, 0.45, 0.3, 10]} />
        <meshStandardMaterial color="#0a0a18" emissive={color} emissiveIntensity={0.35 * intensity} />
      </mesh>

      <mesh position={[0, 0.42, 0]}>
        <sphereGeometry args={[0.18, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} />
      </mesh>

      <mesh ref={glowRef} position={[0, 0.42, 0]}>
        <sphereGeometry args={[0.5, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      <Text
        position={[0, 5.9, 0]}
        fontSize={0.32}
        color={color}
        anchorX="center"
        anchorY="middle"
        font={PIXEL_FONT_URL}
      >
        {label}
      </Text>
      {sublabel && (
        <Text
          position={[0, 5.45, 0]}
          fontSize={0.18}
          color="#cbd5e1"
          anchorX="center"
          anchorY="middle"
          font={PIXEL_FONT_URL}
          maxWidth={6}
        >
          {sublabel}
        </Text>
      )}
    </group>
  );
}

export default function CitySignalBeacons({ positions, reviewCounts, instances }) {
  const config = useMemo(() => {
    if (!positions || positions.size === 0) return [];

    const entries = [];
    positions.forEach((pos) => {
      if (pos.district === 'downtown') entries.push(pos);
    });
    if (entries.length === 0) return [];

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    entries.forEach(p => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });

    const pending = reviewCounts?.total || 0;
    const alerts = reviewCounts?.alert || 0;
    const peers = instances?.peers || [];
    const onlinePeers = peers.filter(peer => peer.online).length;
    const totalNodes = 1 + peers.length;

    return [
      {
        id: 'review-beacon',
        position: [minX - 6, 0, minZ - 6],
        color: alerts > 0 ? '#f97316' : '#06b6d4',
        label: alerts > 0 ? 'REVIEW PRESSURE' : 'REVIEW HUB',
        sublabel: pending > 0 ? `${pending} pending · ${alerts} alerts` : 'inbox clear',
        intensity: alerts > 0 ? 1.6 : pending > 0 ? 1.1 : 0.7,
      },
      {
        id: 'void-beacon',
        position: [maxX + 8, 0, maxZ + 8],
        color: onlinePeers > 0 ? '#8b5cf6' : '#64748b',
        label: 'VOID / INSTANCES',
        sublabel: `${onlinePeers}/${totalNodes} nodes linked`,
        intensity: onlinePeers > 0 ? 1.2 : 0.65,
      }
    ];
  }, [positions, reviewCounts, instances]);

  if (config.length === 0) return null;

  return (
    <group>
      {config.map(beacon => (
        <SignalBeacon key={beacon.id} {...beacon} />
      ))}
    </group>
  );
}
