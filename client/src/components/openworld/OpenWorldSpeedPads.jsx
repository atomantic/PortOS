import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getSpeedPadsList } from '../../utils/openWorldSpeedPads';

function SpeedPad({ pad, animate }) {
  const { x, z, angle, width, length, color } = pad;
  const chevronsRef = useRef();

  useFrame(({ clock }) => {
    if (!animate || !chevronsRef.current) return;
    const t = clock.getElapsedTime();
    // Pulse and animate chevron brightness
    chevronsRef.current.children.forEach((mesh, index) => {
      if (!mesh?.material) return;
      const phase = (t * 3.5 - index * 0.4) % Math.PI;
      const intensity = Math.sin(Math.max(0, phase));
      mesh.material.opacity = 0.35 + intensity * 0.55;
    });
  });

  return (
    <group position={[x, 0.03, z]} rotation={[0, angle, 0]}>
      {/* Base pad plate */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[length, width]} />
        <meshStandardMaterial
          color="#0f172a"
          emissive={color}
          emissiveIntensity={0.25}
          roughness={0.8}
          metalness={0.3}
        />
      </mesh>

      {/* Outer border trim */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <ringGeometry args={[width * 0.46, width * 0.49, 4]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* Chevrons pointing forward (+X in local rotated space) */}
      <group ref={chevronsRef} position={[0, 0.01, 0]}>
        {[-1.3, 0, 1.3].map((offsetX, idx) => (
          <mesh key={idx} position={[offsetX, 0, 0]} rotation={[-Math.PI / 2, 0, -Math.PI / 2]}>
            <coneGeometry args={[0.7, 0.9, 3]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={0.6}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
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
