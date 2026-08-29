import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, openWorldDayMix } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import OpenWorldLabel from './OpenWorldLabel';
import { computeProductivityMonument } from '../../utils/openWorldProductivity';

// OpenWorld's productivity district: a tapered throughput monument whose
// height reflects tasks completed today and whose color reflects recent pace.
export default function OpenWorldProductivityDistrict({ productivityData, settings }) {
  const { tintStructure } = useOpenWorldPalette();
  const monument = useMemo(() => computeProductivityMonument(productivityData), [productivityData]);
  const capRef = useRef();

  // Honor the quality dial: drop the capstone pulse on the lowest preset.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = openWorldDayMix(settings);

  useFrame(({ clock }) => {
    if (!animate || !capRef.current) return;
    const speed = monument.surging ? 3.2 : 1.1;
    const pulse = 0.5 + ((Math.sin(clock.getElapsedTime() * speed) + 1) / 2) * 0.6;
    capRef.current.material.emissiveIntensity = pulse * (monument.intensity + 0.25);
  });

  const { position, baseWidth, height, color } = monument;
  const shaftTop = height; // top of the tapered shaft (above the plinth, see group offset)
  const sublabel = monument.tierLabel;

  return (
    <group position={position}>
      {/* Stepped plinth the obelisk rises from */}
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[baseWidth * 1.6, 0.8, baseWidth * 1.6]} />
        <meshStandardMaterial color={tintStructure('#0a0e16')} emissive={color} emissiveIntensity={0.08} metalness={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.0, 0]}>
        <boxGeometry args={[baseWidth * 1.2, 0.5, baseWidth * 1.2]} />
        <meshStandardMaterial color={tintStructure('#0c121d')} emissive={color} emissiveIntensity={0.12} metalness={0.6} roughness={0.5} />
      </mesh>

      {/* Tapered obelisk shaft — height scales with today's throughput. */}
      <group position={[0, 1.25, 0]}>
        <mesh position={[0, shaftTop / 2, 0]}>
          <cylinderGeometry args={[baseWidth * 0.18, baseWidth * 0.42, shaftTop, 4]} />
          <meshStandardMaterial
            color={tintStructure('#0a0e16')}
            emissive={color}
            emissiveIntensity={0.12 + monument.intensity * 0.25}
            metalness={0.6}
            roughness={0.45}
          />
        </mesh>

        {/* Glowing capstone — the live pace indicator that pulses. */}
        <mesh ref={capRef} position={[0, shaftTop + baseWidth * 0.22, 0]} rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[baseWidth * 0.34, baseWidth * 0.55, 4]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={monument.intensity} toneMapped={false} />
        </mesh>

        {/* District title + throughput above the monument. */}
        <OpenWorldLabel position={[0, shaftTop + 2.6, 0]} fontSize={1.3} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={22}>
          {monument.throughputLabel}
        </OpenWorldLabel>
        <OpenWorldLabel position={[0, shaftTop + 1.7, 0]} fontSize={0.8} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={22}>
          {sublabel}
        </OpenWorldLabel>
      </group>

      {/* Ground readout of today's throughput */}
      <OpenWorldLabel position={[0, 0.05, baseWidth * 1.1]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.7} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={22}>
        {monument.completedToday !== null ? `TODAY ${monument.completedToday} DONE` : 'PRODUCTIVITY'}
      </OpenWorldLabel>
    </group>
  );
}
