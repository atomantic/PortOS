import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { computeChronotypeEnergy } from '../../utils/cityChronotype';

// CyberCity's chronotype energy overlay (roadmap 3.1): a subtle ambient atmosphere
// that brightens and warms the city during the user's peak focus hours and dims it
// during wind-down and recovery hours. It does NOT replace the scene lighting
// (CityLights) — it composes on top with a single gentle, energy-tinted ambient
// light so the user's circadian rhythm reads as the city's mood. No label; it's
// pure ambiance.
//
// The pure helper (cityChronotype.js) takes the hour as a parameter for testability;
// the live hour is computed here in the component.

// Energy mid-point — at neutral energy the overlay contributes almost nothing.
const BASE_INTENSITY = 0.12;

export default function CityEnergyOverlay({ chronotype, settings }) {
  const lightRef = useRef();

  // Honor the quality dial: skip the per-frame energy lerp on the lowest preset, but
  // still apply a static energy tint so the chronotype mood is legible.
  const animate = (settings?.particleDensity ?? 1) >= 0.5;

  // Smoothed brightness so a clock tick across an hour boundary fades rather than jumps.
  const smoothedRef = useRef(null);

  useFrame((_, delta) => {
    if (!lightRef.current) return;

    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    const { brightness } = computeChronotypeEnergy(chronotype, hour);

    // High energy → warmer/brighter; low energy → cooler/dimmer. Intensity rides
    // the brightness modifier (clamped 0.7–1.15 in the helper) so it stays subtle.
    const targetIntensity = BASE_INTENSITY * brightness;

    if (!animate || smoothedRef.current === null) {
      smoothedRef.current = targetIntensity;
    } else {
      const lf = Math.min(1, delta * 1.5);
      smoothedRef.current += (targetIntensity - smoothedRef.current) * lf;
    }

    lightRef.current.intensity = smoothedRef.current;
  });

  // A warm-tinted ambient fill — peak hours glow a touch warmer/brighter, recovery
  // hours fade it toward nothing. Faint by design so it layers over CityLights
  // without washing out the existing palette.
  return <ambientLight ref={lightRef} intensity={BASE_INTENSITY} color="#ffd9a0" />;
}
