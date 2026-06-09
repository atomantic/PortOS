import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, cityDayMix } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';
import CityLabel from './CityLabel';
import { computeArtifacts, ARTIFACTS } from '../../utils/cityArtifacts';

// CyberCity's earned artifacts (roadmap 3.5): a "Hall of Achievements" cluster of trophies
// that only appear once a milestone is earned (level-ups, completed-goal counts, best CoS
// streak). Each artifact is a dark pedestal topped by a glowing faceted emblem (an octahedron)
// — visually distinct from the goal monuments' tower/scaffold so milestones don't read as
// goals. The emblems shimmer in unison via a single per-frame ref mutation, gated on the
// quality dial. Mirrors CityGoalMonuments / CityProductivityDistrict.
function Artifact({ artifact, dayMix = 0 }) {
  const { tintStructure } = useCityPalette();
  const { color, intensity, label, position } = artifact;
  const { pedestalWidth: pw, pedestalHeight: ph, emblemSize } = ARTIFACTS;
  const emblemY = ph + emblemSize * 0.6;

  return (
    <group position={position}>
      {/* Pedestal base */}
      <mesh position={[0, ph / 2, 0]}>
        <cylinderGeometry args={[pw * 0.6, pw * 0.7, ph, 6]} />
        <meshStandardMaterial color={tintStructure('#0a0e16')} emissive={color} emissiveIntensity={0.12} metalness={0.7} roughness={0.4} />
      </mesh>

      {/* Glowing faceted emblem — the artifact itself */}
      <mesh position={[0, emblemY, 0]} rotation={[0, Math.PI / 4, 0]}>
        <octahedronGeometry args={[emblemSize, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={intensity} metalness={0.5} roughness={0.25} toneMapped={false} />
      </mesh>

      {/* A small point light makes the emblem read as a beacon at distance */}
      <pointLight position={[0, emblemY, 0]} color={color} intensity={intensity * 1.5} distance={10} />

      {/* Label below the pedestal */}
      <CityLabel position={[0, ph + emblemSize * 1.7, 0]} fontSize={0.5} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={6}>
        {label}
      </CityLabel>
    </group>
  );
}

export default function CityArtifacts({ character, goals, productivityData, settings }) {
  const hall = useMemo(
    () => computeArtifacts({ character, goals, productivityData }),
    [character, goals, productivityData],
  );

  // Shared shimmer driver: one ref scales emissive intensity for the whole cluster, so the
  // shimmer is a single per-frame mutation regardless of artifact count.
  const groupRef = useRef();

  // Honor the quality dial: drop the shimmer on the lowest preset, but keep the static glow so
  // earned artifacts stay legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = cityDayMix(settings);

  useFrame(({ clock }) => {
    if (!animate || !groupRef.current) return;
    const pulse = (Math.sin(clock.getElapsedTime() * 1.4) + 1) / 2; // 0..1
    const scale = 1 + pulse * 0.08;
    groupRef.current.scale.set(scale, scale, scale);
  });

  if (!hall.hasData) return null;

  const { base, artifacts, total } = hall;

  return (
    <group>
      <group ref={groupRef}>
        {artifacts.map((artifact) => (
          <Artifact key={artifact.id} artifact={artifact} dayMix={dayMix} />
        ))}
      </group>

      {/* District title behind the cluster */}
      <CityLabel position={[base[0], 10, base[2] + 4]} fontSize={1.2} color="#f59e0b" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={24}>
        ACHIEVEMENTS
      </CityLabel>
      <CityLabel position={[base[0], 9, base[2] + 4]} fontSize={0.7} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={24}>
        {`${total} EARNED`}
      </CityLabel>
    </group>
  );
}
