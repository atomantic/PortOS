import { CITY_COLORS } from './cityConstants';

export default function CityLights() {
  return (
    <>
      <ambientLight intensity={0.08} color={CITY_COLORS.ambient} />
      <pointLight position={[0, 20, 0]} intensity={0.6} color="#06b6d4" distance={60} />
      <pointLight position={[-15, 8, -10]} intensity={0.3} color="#ec4899" distance={40} />
      <pointLight position={[15, 8, 10]} intensity={0.3} color="#3b82f6" distance={40} />
      <fog attach="fog" args={[CITY_COLORS.fog, 20, 60]} />
    </>
  );
}
