import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import { getTimeOfDayPreset, cityDayMix, mixHex, seededRand } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';

// Reflective puddle/wet-ground patches
function WetPatch({ position, size, color, dayMix = 0 }) {
  const ref = useRef();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    // Neon puddle reflections are a wet-night look — fade them out by day.
    ref.current.material.opacity = (0.1 + Math.sin(t * 0.8 + position[0] * 3) * 0.04) * (1 - dayMix);
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
function RollingFog({ dayMix = 0 }) {
  const ref = useRef();
  const { ground } = useCityPalette();

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.material.opacity = (0.025 + Math.sin(t * 0.15) * 0.012) * (1 - dayMix);
    ref.current.position.z = Math.sin(t * 0.05) * 3;
  });

  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.5, 0]}>
      <planeGeometry args={[100, 100]} />
      <meshBasicMaterial
        color={ground}
        transparent
        opacity={0.012}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export default function CityGround({ settings }) {
  const { ground, neonAccents } = useCityPalette();
  const reflectionsEnabled = settings?.reflectionsEnabled ?? true;
  const groundMatRef = useRef();

  const timeOfDay = settings?.timeOfDay ?? 'sunset';
  const skyTheme = settings?.skyTheme ?? 'cyberpunk';
  const preset = getTimeOfDayPreset(timeOfDay, skyTheme);
  const dayMix = cityDayMix(settings);
  const groundColorTarget = useRef(new THREE.Color(preset.groundColor ?? '#0a0a20'));
  groundColorTarget.current.set(preset.groundColor ?? '#0a0a20');
  const targetRoughness = preset.groundRoughness ?? 0.7;
  const targetMetalness = 0.4 * (1 - dayMix) + 0.04 * dayMix;

  // The neon grid + additive fog follow the themed accent (palette.ground tracks the
  // theme). At night they read as accent neon; by day the grid mutes to faint pavement
  // lines and the glow fog fades out.
  const accent = ground;
  const gridSectionColor = mixHex(accent, '#bcc4cc', dayMix);
  const gridCellColor = mixHex(mixHex(accent, '#0a1420', 0.5), '#a7afb8', dayMix);
  const groundFogOpacity = 0.045 * (1 - dayMix);

  useFrame((_, delta) => {
    if (!groundMatRef.current) return;
    const lf = Math.min(1, delta * 3);
    groundMatRef.current.color.lerp(groundColorTarget.current, lf);
    groundMatRef.current.roughness += (targetRoughness - groundMatRef.current.roughness) * lf;
    groundMatRef.current.metalness += (targetMetalness - groundMatRef.current.metalness) * lf;
  });

  const puddles = useMemo(() => {
    const result = [];
    const rand = seededRand(137);
    const colors = neonAccents;
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
  }, [reflectionsEnabled, neonAccents]);

  return (
    <group>
      {/* Reflective dark ground plane */}
      {reflectionsEnabled && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
          <planeGeometry args={[120, 120]} />
          <meshStandardMaterial
            ref={groundMatRef}
            color={preset.groundColor ?? '#0a0a20'}
            metalness={targetMetalness}
            roughness={0.7}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      <Grid
        infiniteGrid
        cellSize={2}
        sectionSize={6}
        cellColor={gridCellColor}
        sectionColor={gridSectionColor}
        cellThickness={0.6}
        sectionThickness={1.4}
        fadeDistance={80}
        fadeStrength={0.6}
        position={[0, -0.01, 0]}
      />

      {/* Wet street reflective patches */}
      {puddles.map(p => (
        <WetPatch key={p.id} position={p.position} size={p.size} color={p.color} dayMix={dayMix} />
      ))}

      {/* Subtle ground fog layer (night neon haze; gone by day) */}
      {groundFogOpacity > 0.001 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1, 0]}>
          <planeGeometry args={[80, 80]} />
          <meshBasicMaterial
            color={accent}
            transparent
            opacity={groundFogOpacity}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Rolling fog layer at street level */}
      {reflectionsEnabled && <RollingFog dayMix={dayMix} />}
    </group>
  );
}
