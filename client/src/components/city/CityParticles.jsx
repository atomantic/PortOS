import { Sparkles } from '@react-three/drei';

export default function CityParticles() {
  return (
    <>
      {/* Cyan ambient sparkles - main atmosphere */}
      <Sparkles
        count={80}
        scale={[40, 15, 40]}
        size={1.5}
        speed={0.3}
        opacity={0.25}
        color="#06b6d4"
      />
      {/* Pink/magenta secondary sparkles */}
      <Sparkles
        count={30}
        scale={[30, 10, 30]}
        size={1}
        speed={0.2}
        opacity={0.15}
        color="#ec4899"
      />
      {/* Purple deep sparkles */}
      <Sparkles
        count={20}
        scale={[35, 12, 35]}
        size={0.8}
        speed={0.15}
        opacity={0.1}
        color="#8b5cf6"
      />
    </>
  );
}
