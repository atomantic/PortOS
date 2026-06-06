import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { PIXEL_FONT_URL, cityDayMix, tintStructure } from './cityConstants';
import CityLabel from './CityLabel';
import { computeHealthTower } from '../../utils/cityHealthTower';

// CyberCity's biometric vitals tower (roadmap 2.9): a stacked cylindrical landmark in a
// far-southeast wellness district. Each tier is one Apple Health metric (heart rate, steps,
// active calories, sleep) whose height and glow track that metric's latest value normalized
// against a target. A metric with no data reads as a thin dim disc (absent) — distinct from
// a present-but-zero value, which keeps its lit color. The heart-rate tier pulses like a
// heartbeat, faster as the rate climbs. Mirrors CityBackupVault / CityTaskQueue.
function Segment({ segment, baseRadius, isHeart, heartRef }) {
  const { height, color, intensity } = segment;
  return (
    <mesh ref={isHeart ? heartRef : undefined} position={[0, segment.y, 0]}>
      <cylinderGeometry args={[baseRadius, baseRadius, height, 32]} />
      <meshStandardMaterial
        color={segment.present ? tintStructure('#0c1620') : tintStructure('#0a0e16')}
        emissive={color}
        emissiveIntensity={intensity}
        metalness={0.5}
        roughness={0.5}
        toneMapped={false}
      />
    </mesh>
  );
}

export default function CityHealthTower({ healthMetrics, settings }) {
  const tower = useMemo(() => computeHealthTower(healthMetrics), [healthMetrics]);
  const heartRef = useRef();

  // Honor the quality dial: drop the heartbeat pulse on the lowest preset, but keep the
  // static glow so the vitals stay legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = cityDayMix(settings);

  useFrame(({ clock }) => {
    if (!animate || !heartRef.current || !tower.heartPresent) return;
    // Heartbeat: a higher heart-rate level beats faster. Base intensity comes from the
    // view-model so a present-but-low reading still glows; the pulse rides on top.
    const bpm = 2.2 + tower.heartLevel * 3.5;
    const pulse = (Math.sin(clock.getElapsedTime() * bpm) + 1) / 2; // 0..1
    heartRef.current.material.emissiveIntensity = tower.heartIntensity + pulse * 0.6;
  });

  const { position, baseRadius, segments, totalHeight, hasData } = tower;

  return (
    <group position={position}>
      {/* Plinth the tower rises from */}
      <mesh position={[0, 0.3, 0]}>
        <cylinderGeometry args={[baseRadius * 1.3, baseRadius * 1.45, 0.6, 32]} />
        <meshStandardMaterial color={tintStructure('#0a0e16')} emissive="#22c55e" emissiveIntensity={0.08} metalness={0.6} roughness={0.5} />
      </mesh>

      {/* Stacked metric segments — lifted above the plinth */}
      <group position={[0, 0.6, 0]}>
        {segments.map((segment) => (
          <Segment
            key={segment.key}
            segment={segment}
            baseRadius={baseRadius}
            isHeart={segment.key === 'heart_rate'}
            heartRef={heartRef}
          />
        ))}

        {/* Per-segment side labels so each tier is identifiable */}
        {segments.map((segment) => (
          <CityLabel
            key={`label-${segment.key}`}
            position={[baseRadius + 0.6, segment.y, 0]}
            fontSize={0.55}
            color={segment.present ? segment.color : '#64748b'}
            dayMix={dayMix}
            anchorX="left"
            anchorY="middle"
            font={PIXEL_FONT_URL}
            maxWidth={14}
          >
            {segment.present ? `${segment.label} ${segment.value}${segment.unit ? ' ' + segment.unit : ''}` : `${segment.label} —`}
          </CityLabel>
        ))}

        {/* Tower title + status above the stack */}
        <CityLabel position={[0, totalHeight + 1.6, 0]} fontSize={1.2} color="#22c55e" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={18}>
          VITALS
        </CityLabel>
        <CityLabel position={[0, totalHeight + 0.8, 0]} fontSize={0.8} color="#94a3b8" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={18}>
          {hasData ? `${tower.presentCount}/${segments.length} TRACKED` : 'NO HEALTH DATA'}
        </CityLabel>
      </group>
    </group>
  );
}
