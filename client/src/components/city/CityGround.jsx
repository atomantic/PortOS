import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import { CITY_COLORS } from './cityConstants';

// Reflective puddle/wet-ground patches
function WetPatch({ position, size, color }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.material.opacity = 0.08 + Math.sin(t * 0.8 + position[0] * 3) * 0.03;
  });

  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={position}>
      <circleGeometry args={[size, 16]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.08}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export default function CityGround() {
  const puddles = useMemo(() => {
    const result = [];
    let s = 137;
    const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s & 0x7fffffff) / 2147483647; };
    const colors = CITY_COLORS.neonAccents;

    for (let i = 0; i < 20; i++) {
      result.push({
        id: `puddle-${i}`,
        position: [(rand() - 0.5) * 40, 0.005, (rand() - 0.5) * 40],
        size: 0.5 + rand() * 2,
        color: colors[Math.floor(rand() * colors.length)],
      });
    }
    return result;
  }, []);

  return (
    <group>
      <Grid
        infiniteGrid
        cellSize={1}
        sectionSize={4}
        cellColor={CITY_COLORS.ground}
        sectionColor={CITY_COLORS.ground}
        cellThickness={0.4}
        sectionThickness={1}
        fadeDistance={50}
        fadeStrength={1}
        position={[0, -0.01, 0]}
      />

      {/* Wet street reflective patches */}
      {puddles.map(p => (
        <WetPatch key={p.id} position={p.position} size={p.size} color={p.color} />
      ))}

      {/* Subtle ground fog layer */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1, 0]}>
        <planeGeometry args={[80, 80]} />
        <meshBasicMaterial
          color="#06b6d4"
          transparent
          opacity={0.015}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
