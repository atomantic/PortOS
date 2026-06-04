import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useTimeTick } from '../../hooks/useTimeTick';
import { PIXEL_FONT_URL, cityDayMix } from './cityConstants';
import CityLabel from './CityLabel';
import { computeSeasonalDecor, SEASONAL_DECOR } from '../../utils/citySeasonalDecor';

// CyberCity's seasonal decorations (roadmap 3.5 follow-up, #824): date-driven city dressing
// that layers the active season's (or holiday's) palette onto a loose ring of glowing accent
// props around the city's edge. The theme is resolved from a date — a holiday window
// (New Year, Halloween, …) overrides the broad season. Props bob/shimmer (each on its own
// phase offset) gated on the quality dial (mirrors CityArtifacts / CityGoalMonuments).
function Decoration({ decoration, color, accent, animate }) {
  const { position, phase } = decoration;
  const s = SEASONAL_DECOR.propSize;
  const ref = useRef();

  // Per-decoration bob, offset by the descriptor's stable phase so the ring doesn't pulse in
  // lockstep. Gated on the quality dial; the static glow remains when animation is off.
  useFrame(({ clock }) => {
    if (!animate || !ref.current) return;
    const pulse = (Math.sin(clock.getElapsedTime() * 1.1 + phase * Math.PI * 2) + 1) / 2; // 0..1
    ref.current.scale.setScalar(1 + pulse * 0.06);
    ref.current.position.y = pulse * 0.6;
  });

  return (
    <group position={position}>
      <group ref={ref}>
        {/* A faceted, glowing prop — abstract enough to read for any season/holiday. */}
        <mesh position={[0, s * 0.6, 0]} rotation={[0, Math.PI / 5, 0]}>
          <coneGeometry args={[s * 0.5, s * 1.4, 5]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.55} metalness={0.4} roughness={0.3} toneMapped={false} />
        </mesh>

        {/* An accent orb crowns the prop — the holiday/season's secondary color. */}
        <mesh position={[0, s * 1.5, 0]}>
          <sphereGeometry args={[s * 0.28, 10, 10]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.8} toneMapped={false} />
        </mesh>

        <pointLight position={[0, s * 1.2, 0]} color={accent} intensity={0.7} distance={9} />
      </group>
    </group>
  );
}

export default function CitySeasonalDecor({ date, settings }) {
  // Re-resolve the theme as real time advances so the dressing turns over at midnight / a holiday
  // boundary while CyberCity stays open — an hourly tick is plenty for a calendar-day theme and is
  // battery-friendly (shared singleton timer, paused while the tab is hidden). An explicit `date`
  // prop still wins for callers/tests; the pure helper is what the unit tests exercise directly.
  const tick = useTimeTick(3600000);
  const decor = useMemo(
    () => computeSeasonalDecor(date ?? new Date(tick)),
    [date, tick],
  );

  // Honor the quality dial: drop the bob/shimmer on the lowest preset, keep the static glow.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;
  const dayMix = cityDayMix(settings);

  if (!decor.hasData) return null;

  const { decorations, color, accent, label, base } = decor;

  return (
    <group>
      {decorations.map((decoration) => (
        <Decoration key={decoration.id} decoration={decoration} color={color} accent={accent} animate={animate} />
      ))}

      {/* Season/holiday banner high above the city center so it reads as ambient context. */}
      <CityLabel position={[base[0], 34, base[2]]} fontSize={1.6} color={color} dayMix={dayMix} anchorX="center" anchorY="middle" font={PIXEL_FONT_URL} maxWidth={40}>
        {label}
      </CityLabel>
    </group>
  );
}
