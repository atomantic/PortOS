import { Sparkles } from '@react-three/drei';
import { CITY_COLORS } from './cityConstants';

export default function CityParticles() {
  return (
    <Sparkles
      count={100}
      scale={[40, 15, 40]}
      size={1.5}
      speed={0.3}
      opacity={0.3}
      color={CITY_COLORS.particles}
    />
  );
}
