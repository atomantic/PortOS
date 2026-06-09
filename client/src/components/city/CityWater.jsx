import { useMemo, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { cityDayMix, mixHex } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';
import { WORLD } from '../../utils/cityPlan';

// The bay: a water plane filling everything north of the master plan's shoreline
// (see cityPlan.js — the Data Harbor's piers stand over it, the federation peers
// read as cities across it). Deliberately cheap: one textured plane + one additive
// shimmer strip at the shoreline — no reflection/refraction passes, matching the
// city's no-postprocessing rule. Day/night follows cityDayMix like every surface.

const NIGHT_WATER = '#050d1c'; // near-black ink so neon reflections read
const DAY_WATER = '#2e4f6e'; // steel-blue daytime bay

// Procedural wave streaks: sparse horizontal sine ridges on a transparent canvas,
// tiled + scrolled as the emissive map so the water reads as slowly moving swell.
const makeWaveTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  ctx.lineWidth = 1.2;
  for (let row = 0; row < 10; row++) {
    const y = (row + 0.5) * 25.6;
    const amp = 2 + (row % 3) * 1.5;
    const phase = row * 1.7;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.16 + (row % 4) * 0.05})`;
    ctx.beginPath();
    for (let x = 0; x <= 256; x += 4) {
      const wy = y + Math.sin(x / 28 + phase) * amp;
      if (x === 0) ctx.moveTo(x, wy);
      else ctx.lineTo(x, wy);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(26, 14);
  return tex;
};

export default function CityWater({ settings }) {
  const { accent } = useCityPalette();
  const dayMix = cityDayMix(settings);
  const waveTex = useMemo(() => makeWaveTexture(), []);
  useEffect(() => () => waveTex.dispose(), [waveTex]);

  const shimmerRef = useRef();

  const waterColor = mixHex(NIGHT_WATER, DAY_WATER, dayMix);
  // Night: the swell glows faint accent neon. Day: barely-there white glints.
  const emissiveColor = mixHex(accent, '#dfeaf2', dayMix);
  const emissiveIntensity = 0.4 * (1 - dayMix) + 0.1 * dayMix;

  useFrame(({ clock }, delta) => {
    // Slow drift toward shore with a gentle cross-current wobble.
    waveTex.offset.y -= delta * 0.012;
    waveTex.offset.x = Math.sin(clock.getElapsedTime() * 0.05) * 0.03;
    if (shimmerRef.current) {
      const t = clock.getElapsedTime();
      shimmerRef.current.material.opacity =
        (0.14 + Math.sin(t * 0.9) * 0.05) * (1 - dayMix) + 0.05 * dayMix;
    }
  });

  const span = WORLD.waterSpan;
  const centerZ = WORLD.shorelineZ - span / 2;

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, WORLD.waterY, centerZ]}>
        <planeGeometry args={[span * 2, span]} />
        <meshStandardMaterial
          color={waterColor}
          roughness={0.18}
          metalness={0.55}
          emissive={emissiveColor}
          emissiveIntensity={emissiveIntensity}
          emissiveMap={waveTex}
        />
      </mesh>
      {/* Shoreline shimmer — a thin additive surf line where land meets the bay. */}
      <mesh
        ref={shimmerRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, WORLD.waterY + 0.015, WORLD.shorelineZ - 0.9]}
      >
        <planeGeometry args={[320, 1.8]} />
        <meshBasicMaterial
          color={accent}
          transparent
          opacity={0.14}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
