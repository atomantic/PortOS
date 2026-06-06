import { forwardRef } from 'react';
import { Text } from '@react-three/drei';
import { cityLabelColors } from './cityConstants';

// A drei <Text> for an informational in-world label (app/process names, district
// readouts) that stays legible day AND night. Pass the night/neon `color` plus the
// scene `dayMix` (0 night → 1 day); the label keeps its neon fill at night and swaps
// to dark ink + a light outline halo as day ramps up. Every other <Text> prop
// (position, fontSize, font, anchorX, fillOpacity, children, …) passes straight
// through. A caller may still override `outlineColor` explicitly.
//
// Use this for content the user needs to READ in daytime. Decorative neon signage
// (CityNeonSigns, ambient billboards) intentionally does NOT use it — neon should
// dim in daylight like the real thing.
const CityLabel = forwardRef(function CityLabel({ color, dayMix = 0, outlineColor, ...props }, ref) {
  const themed = cityLabelColors(color, dayMix);
  return (
    <Text
      ref={ref}
      {...props}
      color={themed.color}
      outlineColor={outlineColor ?? themed.outlineColor}
      outlineWidth={themed.outlineWidth}
      outlineOpacity={themed.outlineOpacity}
    />
  );
});

export default CityLabel;
