import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getSpeedPadsList } from '../../utils/openWorldSpeedPads';
import { openWorldTerrainHeight } from '../../utils/openWorldPlan';

function SpeedPad({ pad, animate }) {
  const { x, z, angle, width, length, color } = pad;
  const chevronsRef = useRef();

  useFrame(({ clock }) => {
    if (!animate || !chevronsRef.current) return;
    const t = clock.getElapsedTime();
    // A soft traveling paint shimmer makes the boost readable without a neon plate.
    chevronsRef.current.children.forEach((mesh, index) => {
      if (!mesh?.material) return;
      const phase = (t * 3.5 - index * 0.4) % Math.PI;
      const intensity = Math.sin(Math.max(0, phase));
      mesh.material.opacity = 0.5 + intensity * 0.35;
    });
  });

  return (
    <group position={[x, openWorldTerrainHeight(x, z) + 0.07, z]} rotation={[0, angle, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[length, width]} />
        <meshStandardMaterial
          color="#d8bc7d"
          emissive={color}
          emissiveIntensity={0.06}
          roughness={0.96}
          metalness={0}
        />
      </mesh>

      {/* Three hand-painted arrows point along the lane. */}
      <group ref={chevronsRef} position={[0, 0.01, 0]}>
        {[-1.25, 0, 1.25].map((offsetX, idx) => (
          <mesh key={idx} position={[offsetX, 0, 0]} rotation={[-Math.PI / 2, 0, -Math.PI / 2]}>
            <coneGeometry args={[0.62, 0.82, 3]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={0.72}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}

export default function OpenWorldSpeedPads({ settings }) {
  const pads = useMemo(() => getSpeedPadsList(), []);
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  return (
    <group>
      {pads.map((pad) => (
        <SpeedPad key={pad.id} pad={pad} animate={animate} />
      ))}
    </group>
  );
}
