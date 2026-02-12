import { Sparkles } from '@react-three/drei';

export default function CityParticles() {
  return (
    <>
      {/* Cyan ambient sparkles - main atmosphere */}
      <Sparkles
        count={120}
        scale={[50, 20, 50]}
        size={1.8}
        speed={0.3}
        opacity={0.3}
        color="#06b6d4"
      />
      {/* Pink/magenta secondary sparkles */}
      <Sparkles
        count={50}
        scale={[40, 15, 40]}
        size={1.2}
        speed={0.25}
        opacity={0.2}
        color="#ec4899"
      />
      {/* Purple deep sparkles */}
      <Sparkles
        count={35}
        scale={[45, 15, 45]}
        size={1}
        speed={0.2}
        opacity={0.15}
        color="#8b5cf6"
      />
      {/* Orange warm dust near ground */}
      <Sparkles
        count={25}
        scale={[35, 5, 35]}
        size={0.8}
        speed={0.15}
        opacity={0.12}
        color="#f97316"
        position={[0, 2, 0]}
      />
      {/* Blue high-altitude sparkles */}
      <Sparkles
        count={30}
        scale={[50, 8, 50]}
        size={0.6}
        speed={0.1}
        opacity={0.1}
        color="#3b82f6"
        position={[0, 15, 0]}
      />
    </>
  );
}
