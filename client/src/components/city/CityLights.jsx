import { CITY_COLORS } from './cityConstants';

export default function CityLights() {
  return (
    <>
      <ambientLight intensity={0.06} color={CITY_COLORS.ambient} />
      {/* Main overhead cyan - brighter */}
      <pointLight position={[0, 25, 0]} intensity={0.6} color="#06b6d4" distance={80} />
      {/* Magenta accent from left - stronger */}
      <pointLight position={[-20, 10, -15]} intensity={0.45} color="#ec4899" distance={55} />
      {/* Blue accent from right - stronger */}
      <pointLight position={[20, 10, 15]} intensity={0.45} color="#3b82f6" distance={55} />
      {/* Purple from behind - more presence */}
      <pointLight position={[0, 15, -25]} intensity={0.3} color="#8b5cf6" distance={50} />
      {/* Warm orange ground level accent */}
      <pointLight position={[10, 3, 5]} intensity={0.2} color="#f97316" distance={30} />
      {/* Additional green accent - ground level from opposite side */}
      <pointLight position={[-12, 2, 8]} intensity={0.12} color="#22c55e" distance={20} />
      {/* Red warning accent from below-right */}
      <pointLight position={[15, 1, -10]} intensity={0.08} color="#f43f5e" distance={18} />
      {/* Deep fog for depth fade - pushes out further */}
      <fog attach="fog" args={[CITY_COLORS.fog, 30, 80]} />
    </>
  );
}
