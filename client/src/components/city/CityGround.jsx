import { Grid } from '@react-three/drei';
import { CITY_COLORS } from './cityConstants';

export default function CityGround() {
  return (
    <Grid
      infiniteGrid
      cellSize={1}
      sectionSize={4}
      cellColor={CITY_COLORS.ground}
      sectionColor={CITY_COLORS.ground}
      cellThickness={0.4}
      sectionThickness={1}
      fadeDistance={50}
      fadeStrength={1}
      position={[0, -0.01, 0]}
    />
  );
}
