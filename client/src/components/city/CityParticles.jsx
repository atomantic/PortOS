import { Sparkles } from '@react-three/drei';
import { cityDayMix } from './cityConstants';
import { useCityPalette } from './CityPaletteContext';

export default function CityParticles({ settings }) {
  const { particles } = useCityPalette();
  const density = settings?.particleDensity ?? 1.0;
  const scale = (base) => Math.max(1, Math.round(base * density));
  // Neon atmosphere dust is a night look — fade it out in daylight.
  const dayFade = 1 - cityDayMix(settings);

  return (
    <>
      {/* Primary ambient sparkles — follow the themed accent (palette.particles). */}
      <Sparkles
        count={scale(120)}
        scale={[50, 20, 50]}
        size={1.8}
        speed={0.3}
        opacity={0.3 * dayFade}
        color={particles}
      />
      {/* Pink/magenta secondary sparkles */}
      <Sparkles
        count={scale(50)}
        scale={[40, 15, 40]}
        size={1.2}
        speed={0.25}
        opacity={0.2 * dayFade}
        color="#ec4899"
      />
      {/* Purple deep sparkles */}
      <Sparkles
        count={scale(35)}
        scale={[45, 15, 45]}
        size={1}
        speed={0.2}
        opacity={0.15 * dayFade}
        color="#8b5cf6"
      />
      {/* Orange warm dust near ground */}
      <Sparkles
        count={scale(25)}
        scale={[35, 5, 35]}
        size={0.8}
        speed={0.15}
        opacity={0.12 * dayFade}
        color="#f97316"
        position={[0, 2, 0]}
      />
      {/* Blue high-altitude sparkles */}
      <Sparkles
        count={scale(30)}
        scale={[50, 8, 50]}
        size={0.6}
        speed={0.1}
        opacity={0.1 * dayFade}
        color="#3b82f6"
        position={[0, 15, 0]}
      />
    </>
  );
}
