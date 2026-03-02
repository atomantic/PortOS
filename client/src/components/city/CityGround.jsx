import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import { CITY_COLORS, getTimeOfDayPreset } from './cityConstants';

// Reflective puddle/wet-ground patches
function WetPatch({ position, size, color }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.material.opacity = 0.1 + Math.sin(t * 0.8 + position[0] * 3) * 0.04;
  });

  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={position}>
      <circleGeometry args={[size, 16]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.1}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// Rolling fog layer with animated opacity
function RollingFog() {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.material.opacity = 0.025 + Math.sin(t * 0.15) * 0.012;
    ref.current.position.z = Math.sin(t * 0.05) * 3;
  });

  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.5, 0]}>
      <planeGeometry args={[100, 100]} />
      <meshBasicMaterial
        color="#06b6d4"
        transparent
        opacity={0.012}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export default function CityGround({ settings }) {
  const reflectionsEnabled = settings?.reflectionsEnabled ?? true;
  const groundMatRef = useRef();

  const timeOfDay = settings?.timeOfDay ?? 'sunset';
  const skyTheme = settings?.skyTheme ?? 'cyberpunk';
  const preset = getTimeOfDayPreset(timeOfDay, skyTheme);
  const groundColorTarget = useRef(new THREE.Color(preset.groundColor ?? '#0a0a20'));
  groundColorTarget.current.set(preset.groundColor ?? '#0a0a20');
  const targetRoughness = preset.groundRoughness ?? 0.7;

  useFrame((_, delta) => {
    if (!groundMatRef.current) return;
    const lf = Math.min(1, delta * 3);
    groundMatRef.current.color.lerp(groundColorTarget.current, lf);
    groundMatRef.current.roughness += (targetRoughness - groundMatRef.current.roughness) * lf;
  });

  const puddles = useMemo(() => {
    const result = [];
    let s = 137;
    const rand = () => { s = (s * 16807 + 0) % 2147483647; return (s & 0x7fffffff) / 2147483647; };
    const colors = CITY_COLORS.neonAccents;
    const count = reflectionsEnabled ? 40 : 20;

    for (let i = 0; i < count; i++) {
      result.push({
        id: `puddle-${i}`,
        position: [(rand() - 0.5) * 50, 0.005, (rand() - 0.5) * 50],
        size: 0.5 + rand() * 2.5,
        color: colors[Math.floor(rand() * colors.length)],
      });
    }
    return result;
  }, [reflectionsEnabled]);

  return (
    <group>
      {/* Reflective dark ground plane */}
      {reflectionsEnabled && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
          <planeGeometry args={[120, 120]} />
          <meshStandardMaterial
            ref={groundMatRef}
            color="#0a0a20"
            metalness={0.4}
            roughness={0.7}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      <Grid
        infiniteGrid
        cellSize={2}
        sectionSize={6}
        cellColor="#0e7490"
        sectionColor="#06b6d4"
        cellThickness={0.6}
        sectionThickness={1.4}
        fadeDistance={80}
        fadeStrength={0.6}
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
          opacity={0.045}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Rolling fog layer at street level */}
      {reflectionsEnabled && <RollingFog />}
    </group>
  );
}
