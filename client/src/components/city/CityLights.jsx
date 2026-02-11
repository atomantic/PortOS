import { CITY_COLORS } from './cityConstants';

export default function CityLights() {
  return (
    <>
      <ambientLight intensity={0.05} color={CITY_COLORS.ambient} />
      {/* Main overhead cyan */}
      <pointLight position={[0, 25, 0]} intensity={0.5} color="#06b6d4" distance={70} />
      {/* Magenta accent from left */}
      <pointLight position={[-20, 10, -15]} intensity={0.35} color="#ec4899" distance={50} />
      {/* Blue accent from right */}
      <pointLight position={[20, 10, 15]} intensity={0.35} color="#3b82f6" distance={50} />
      {/* Purple from behind */}
      <pointLight position={[0, 12, -25]} intensity={0.2} color="#8b5cf6" distance={45} />
      {/* Warm orange ground level */}
      <pointLight position={[10, 3, 5]} intensity={0.15} color="#f97316" distance={25} />
      {/* Deep fog for depth fade */}
      <fog attach="fog" args={[CITY_COLORS.fog, 25, 70]} />
    </>
  );
}
