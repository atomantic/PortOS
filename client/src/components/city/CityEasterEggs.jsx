import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useTimeTick } from '../../hooks/useTimeTick';
import { PIXEL_FONT_URL, cityDayMix } from './cityConstants';
import CityLabel from './CityLabel';
import { computeEasterEggs, EGGS } from '../../utils/cityEasterEggs';

// CyberCity's easter eggs (roadmap 3.5 follow-up, #824): rare, hidden emblems that only appear
// when a special condition is met (a developer's date, a "leet" level, a palindrome streak, a
// clean-sweep goal board). Tucked in a quiet far corner so they read as a discovery, not a
// featured district. Each egg is a small glowing icosahedron with a tiny glyph label; they bob
// (each on its own phase offset) gated on the quality dial (mirrors CityArtifacts).
function Egg({ egg, animate, dayMix = 0 }) {
  const { color, label, hint, position, phase } = egg;
  const s = EGGS.size;
  const ref = useRef();

  // Per-egg twinkle/bob, offset by the descriptor's stable phase so eggs don't pulse in lockstep.
  useFrame(({ clock }) => {
    if (!animate || !ref.current) return;
    const t = clock.getElapsedTime();
    const pulse = (Math.sin(t * 2 + phase * Math.PI * 2) + 1) / 2; // 0..1, faster = twinkly
    ref.current.position.y = pulse * 0.4;
    ref.current.rotation.y = t * 0.3;
  });

  return (
    <group position={position}>
      <group ref={ref}>
        <mesh rotation={[0, Math.PI / 6, 0]}>
          <icosahedronGeometry args={[s, 0]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} metalness={0.6} roughness={0.2} toneMapped={false} />
        </mesh>

        <pointLight color={color} intensity={1.1} distance={8} />

        {/* Tiny glyph so the egg hints at what it is without spelling it out. */}
        <CityLabel position={[0, s + 0.5, 0]} fontSize={0.45} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={6}>
          {label}
        </CityLabel>

        {/* A muted hint sits below the glyph — the discovery payoff up close, kept small and dim
            so eggs still read as "hidden" from across the city. */}
        <CityLabel position={[0, s - 0.4, 0]} fontSize={0.28} color="#64748b" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={8}>
          {hint}
        </CityLabel>
      </group>
    </group>
  );
}

export default function CityEasterEggs({ date, character, goals, productivityData, settings }) {
  // Re-resolve unlocked eggs as real time advances so calendar eggs (e.g. April 1) turn over at the
  // day boundary while CyberCity stays open — an hourly tick is plenty and battery-friendly (shared
  // singleton timer, paused while hidden). An explicit `date` prop still wins for callers/tests.
  const tick = useTimeTick(3600000);
  const cluster = useMemo(
    () => computeEasterEggs({ date: date ?? new Date(tick), character, goals, productivityData }),
    [date, tick, character, goals, productivityData],
  );

  // Honor the quality dial: drop the bob on the lowest preset, keep the static glow.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = cityDayMix(settings);

  if (!cluster.hasData) return null;

  const { base, eggs } = cluster;

  return (
    <group>
      {eggs.map((egg) => (
        <Egg key={egg.id} egg={egg} animate={animate} dayMix={dayMix} />
      ))}

      {/* A faint marker so a found cluster has a label, kept small to preserve the "hidden" feel. */}
      <CityLabel position={[base[0], 6, base[2]]} fontSize={0.7} color="#64748b" dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={20}>
        :)
      </CityLabel>
    </group>
  );
}
