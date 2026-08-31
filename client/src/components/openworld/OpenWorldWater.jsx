import { useMemo, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { openWorldDayMix, mixHex } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { WORLD } from '../../utils/openWorldPlan';

// The world-sea below the PortOS archipelago. Deliberately cheap: one tiled wave
// texture and a soft second swell layer, no reflection/refraction pass. The raised
// islands provide the shoreline, so the water can continue beneath every causeway
// and through every inlet without geometry seams.

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
  ctx.lineWidth = 0.8;
  for (let row = 0; row < 8; row++) {
    const y = (row + 0.5) * 32;
    const amp = 2 + (row % 3) * 1.5;
    const phase = row * 1.7;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.07 + (row % 4) * 0.025})`;
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
  tex.repeat.set(18, 10);
  return tex;
};

export default function OpenWorldWater({ settings }) {
  const { accent } = useOpenWorldPalette();
  const naturalDayMix = openWorldDayMix(settings);
  const dayMix = settings?.explorationMode ? Math.max(0.68, naturalDayMix) : naturalDayMix;
  const waveTex = useMemo(() => makeWaveTexture(), []);
  useEffect(() => () => waveTex.dispose(), [waveTex]);

  const swellRef = useRef();

  const waterColor = mixHex(NIGHT_WATER, DAY_WATER, dayMix);
  // Night: the swell glows faint accent neon. Day: barely-there white glints.
  const emissiveColor = mixHex(accent, '#dfeaf2', dayMix);
  const emissiveIntensity = 0.28 * (1 - dayMix) + 0.07 * dayMix;

  useFrame(({ clock }, delta) => {
    // Two motions at different scales keep the sea from reading as a scrolling decal.
    waveTex.offset.y -= delta * 0.012;
    waveTex.offset.x = Math.sin(clock.getElapsedTime() * 0.05) * 0.03;
    if (swellRef.current) {
      const t = clock.getElapsedTime();
      swellRef.current.rotation.z = Math.sin(t * 0.035) * 0.025;
      swellRef.current.material.opacity = 0.04 + Math.sin(t * 0.22) * 0.012;
    }
  });

  const span = WORLD.waterSpan;

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, WORLD.waterY, 0]}>
        <planeGeometry args={[span * 2, span * 2]} />
        <meshStandardMaterial
          color={waterColor}
          roughness={0.4}
          metalness={0.28}
          emissive={emissiveColor}
          emissiveIntensity={emissiveIntensity}
          emissiveMap={waveTex}
        />
      </mesh>
      <mesh
        ref={swellRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, WORLD.waterY + 0.018, 0]}
      >
        <ringGeometry args={[34, 185, 96]} />
        <meshBasicMaterial
          color={mixHex(accent, '#dff7ff', dayMix * 0.7)}
          transparent
          opacity={0.04}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
