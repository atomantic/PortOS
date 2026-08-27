import { Sparkles } from '@react-three/drei';
import { openWorldDayMix } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';

const NIGHT_LAYERS = [
  { count: 120, scale: [50, 20, 50], size: 1.8, speed: 0.3, opacity: 0.3 },
  { count: 50, scale: [40, 15, 40], size: 1.2, speed: 0.25, opacity: 0.2, color: '#ec4899' },
  { count: 35, scale: [45, 15, 45], size: 1, speed: 0.2, opacity: 0.15, color: '#8b5cf6' },
  { count: 25, scale: [35, 5, 35], size: 0.8, speed: 0.15, opacity: 0.12, color: '#f97316', position: [0, 2, 0] },
  { count: 30, scale: [50, 8, 50], size: 0.6, speed: 0.1, opacity: 0.1, color: '#3b82f6', position: [0, 15, 0] },
];

function nightLayerCount(tier) {
  if (tier === 'low') return 1;
  if (tier === 'medium') return 2;
  if (tier === 'ultra') return 5;
  return 3;
}

export default function OpenWorldParticles({ settings }) {
  const { particles, lowPoly } = useOpenWorldPalette();
  const density = settings?.particleDensity ?? 1.0;
  const scale = (base) => Math.max(1, Math.round(base * density));
  const dayMix = openWorldDayMix(settings);
  const dayFade = 1 - dayMix;

  if (density <= 0) return null;

  const layers = NIGHT_LAYERS.slice(0, nightLayerCount(settings?.effectiveTier));
  const pollenCount = settings?.effectiveTier === 'low' ? 28 : (lowPoly ? 70 : 40);

  return (
    <>
      {/* Daylight meadow motes: soft golden pollen drifting in the sunlit breeze */}
      {dayMix > 0.1 && (
        <Sparkles
          count={scale(pollenCount)}
          scale={[60, 16, 60]}
          size={1.4}
          speed={0.2}
          opacity={0.35 * dayMix}
          color="#fde047"
          position={[0, 4, 0]}
        />
      )}

      {/* Night-time neon atmospheric dust — layer count follows the render tier so
          a struggling GPU sheds sparkle systems before it sheds buildings. */}
      {dayFade > 0.05 && layers.map((layer, i) => (
        <Sparkles
          key={i}
          count={scale(layer.count)}
          scale={layer.scale}
          size={layer.size}
          speed={layer.speed}
          opacity={layer.opacity * dayFade}
          color={layer.color ?? particles}
          position={layer.position}
        />
      ))}
    </>
  );
}
