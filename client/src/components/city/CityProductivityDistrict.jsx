import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import { PIXEL_FONT_URL } from './cityConstants';
import { computeProductivityMonument } from '../../utils/cityProductivity';

// CyberCity's productivity district (roadmap 2.6): a tapered streak monument (an obelisk on
// a stepped plinth) in a southwest district. Its height and glow scale with the user's
// current CoS completion streak; its color tiers by recent velocity (green surging → blue
// steady → amber slowing → red idle). No productivity data reads dim slate ("NO DATA"),
// distinct from a real zero-day streak. The capstone pulses brighter the longer the streak,
// faster while velocity is surging. Mirrors CityBackupVault / CityHealthTower.
export default function CityProductivityDistrict({ productivityData, settings }) {
  const monument = useMemo(() => computeProductivityMonument(productivityData), [productivityData]);
  const capRef = useRef();

  // Honor the quality dial: drop the capstone pulse on the lowest preset, but keep the
  // static glow so the streak is still legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  useFrame(({ clock }) => {
    if (!animate || !capRef.current) return;
    // A longer streak breathes brighter; a surging velocity beats faster.
    const speed = monument.surging ? 3.2 : 1.1;
    const pulse = 0.5 + ((Math.sin(clock.getElapsedTime() * speed) + 1) / 2) * 0.6;
    capRef.current.material.emissiveIntensity = pulse * (monument.intensity + 0.25);
  });

  const { position, baseWidth, height, color } = monument;
  const shaftTop = height; // top of the tapered shaft (above the plinth, see group offset)
  const sublabel = monument.present && monument.longest !== null
    ? `${monument.tierLabel} · BEST ${monument.longest}`
    : monument.tierLabel;

  return (
    <group position={position}>
      {/* Stepped plinth the obelisk rises from */}
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[baseWidth * 1.6, 0.8, baseWidth * 1.6]} />
        <meshStandardMaterial color="#0a0e16" emissive={color} emissiveIntensity={0.08} metalness={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.0, 0]}>
        <boxGeometry args={[baseWidth * 1.2, 0.5, baseWidth * 1.2]} />
        <meshStandardMaterial color="#0c121d" emissive={color} emissiveIntensity={0.12} metalness={0.6} roughness={0.5} />
      </mesh>

      {/* Tapered obelisk shaft — height scales with the streak */}
      <group position={[0, 1.25, 0]}>
        <mesh position={[0, shaftTop / 2, 0]}>
          <cylinderGeometry args={[baseWidth * 0.18, baseWidth * 0.42, shaftTop, 4]} />
          <meshStandardMaterial
            color="#0a0e16"
            emissive={color}
            emissiveIntensity={0.12 + monument.intensity * 0.25}
            metalness={0.6}
            roughness={0.45}
          />
        </mesh>

        {/* Glowing capstone — the live streak indicator that pulses */}
        <mesh ref={capRef} position={[0, shaftTop + baseWidth * 0.22, 0]} rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[baseWidth * 0.34, baseWidth * 0.55, 4]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={monument.intensity} toneMapped={false} />
        </mesh>

        {/* District title + streak above the monument */}
        <Text position={[0, shaftTop + 2.6, 0]} fontSize={1.3} color={color} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={22}>
          {monument.streakLabel}
        </Text>
        <Text position={[0, shaftTop + 1.7, 0]} fontSize={0.8} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={22}>
          {sublabel}
        </Text>
      </group>

      {/* Ground readout of today's throughput */}
      <Text position={[0, 0.05, baseWidth * 1.1]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.7} color="#94a3b8" anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={22}>
        {monument.completedToday !== null ? `TODAY ${monument.completedToday} DONE` : 'PRODUCTIVITY'}
      </Text>
    </group>
  );
}
