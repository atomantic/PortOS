import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import { getTimeOfDayPreset, openWorldDayMix, mixHex, seededRand } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { WORLD } from '../../utils/openWorldPlan';

// The city ground stops at the master plan's shoreline (z = WORLD.shorelineZ) — the bay
// (OpenWorldWater) owns everything north of it. Both the pavement plane and the neon grid are
// sized/offset to end exactly at the water's edge.
const GROUND_HALF = WORLD.landHalf;
const GROUND_DEPTH = GROUND_HALF - WORLD.shorelineZ; // shoreline → +landHalf
const GROUND_CENTER_Z = (GROUND_HALF + WORLD.shorelineZ) / 2;

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
  const { ground } = useOpenWorldPalette();

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

export default function WorldGround({ settings }) {
  const { ground, neonAccents, lowPoly } = useOpenWorldPalette();
  // Wet-night dressing is now an art-direction/performance decision, not a user-facing
  // toggle. The ground itself must always render: the old REFLECTIONS setting accidentally
  // removed the base plane on low quality, leaving only the debug-like grid underneath the
  // player. Vibes stays clean and matte; Cyber City keeps a small wet-night layer above the
  // always-present pavement.
  const wetEffectsEnabled = !lowPoly && settings?.effectiveTier !== 'low';
  const groundMatRef = useRef();

  const timeOfDay = settings?.timeOfDay ?? 'sunset';
  const skyTheme = settings?.skyTheme ?? 'cyberpunk';
  const preset = getTimeOfDayPreset(timeOfDay, skyTheme);
  const dayMix = openWorldDayMix(settings);
  const groundColorTarget = useRef(new THREE.Color(preset.groundColor ?? '#0a0a20'));
  groundColorTarget.current.set(preset.groundColor ?? '#0a0a20');
  const targetRoughness = preset.groundRoughness ?? 0.7;
  const targetMetalness = 0.4 * (1 - dayMix) + 0.04 * dayMix;

  // The neon grid + additive fog follow the themed accent (palette.ground tracks the
  // theme). At night they read as accent neon; by day the grid mutes to faint pavement
  // lines and the glow fog fades out.
  const accent = ground;
  // The original cyber grid is useful orientation in the neon world, but a dense
  // cyan debug grid fights the open-air Vibes landscape. Keep a sparse, low-contrast
  // field there so the player can still read distance without feeling boxed into a UI.
  const gridSectionColor = lowPoly
    ? mixHex('#6d8f77', '#c5a77d', dayMix)
    : mixHex(accent, '#bcc4cc', dayMix);
  const gridCellColor = lowPoly
    ? mixHex('#557866', '#9eb39a', dayMix)
    : mixHex(mixHex(accent, '#0a1420', 0.5), '#a7afb8', dayMix);
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
    const count = wetEffectsEnabled ? 40 : 0;

    for (let i = 0; i < count; i++) {
      result.push({
        id: `puddle-${i}`,
        position: [(rand() - 0.5) * 50, 0.005, (rand() - 0.5) * 50],
        size: 0.5 + rand() * 2.5,
        color: colors[Math.floor(rand() * colors.length)],
      });
    }
    return result;
  }, [wetEffectsEnabled, neonAccents]);

  return (
    <group>
      {/* Always-present ground plane. Surface finish follows the active world style and
          preset; it is never removed by a quality choice. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, WORLD.groundY, GROUND_CENTER_Z]}>
        <planeGeometry args={[GROUND_HALF * 2, GROUND_DEPTH]} />
        <meshStandardMaterial
          ref={groundMatRef}
          color={preset.groundColor ?? '#0a0a20'}
          metalness={targetMetalness}
          roughness={0.7}
          side={THREE.DoubleSide}
        />
      </mesh>

      <Grid
        args={[GROUND_HALF * 2, GROUND_DEPTH]}
        cellSize={lowPoly ? 4 : 2}
        sectionSize={lowPoly ? 16 : 6}
        cellColor={gridCellColor}
        sectionColor={gridSectionColor}
        cellThickness={lowPoly ? 0.22 : 0.6}
        sectionThickness={lowPoly ? 0.55 : 1.4}
        fadeDistance={80}
        fadeStrength={lowPoly ? 0.8 : 0.6}
        position={[0, -0.01, GROUND_CENTER_Z]}
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
      {wetEffectsEnabled && <RollingFog dayMix={dayMix} />}
    </group>
  );
}
