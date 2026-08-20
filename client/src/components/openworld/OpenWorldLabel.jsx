import { forwardRef } from 'react';
import { Text } from '@react-three/drei';
import { openWorldLabelColors } from './openWorldConstants';

// A drei <Text> for an informational in-world label (app/process names, district
// readouts) that stays legible day AND night. Pass the night/neon `color` plus the
// scene `dayMix` (0 night → 1 day); the label keeps its neon fill at night and swaps
// to dark ink + a light outline halo as day ramps up. Every other <Text> prop
// (position, fontSize, font, anchorX, fillOpacity, children, …) passes straight
// through. A caller may still override `outlineColor` explicitly.
//
// Use this for content the user needs to READ in daytime. Decorative neon signage
// (OpenWorldNeonSigns, ambient billboards) intentionally does NOT use it — neon should
// dim in daylight like the real thing.
const OpenWorldLabel = forwardRef(function OpenWorldLabel({ color, dayMix = 0, outlineColor, ...props }, ref) {
  const themed = openWorldLabelColors(color, dayMix);
  // Small tracking and a consistent line box keep stacked labels from collapsing into
  // the pixel glyphs. A slight depth bias prevents facades and signs from eating the ink.
  return (
    <Text
      ref={ref}
      {...props}
      letterSpacing={props.letterSpacing ?? 0.01}
      lineHeight={props.lineHeight ?? 1.1}
      depthOffset={props.depthOffset ?? -1}
      color={themed.color}
      outlineColor={outlineColor ?? themed.outlineColor}
      outlineWidth={themed.outlineWidth}
      outlineOpacity={themed.outlineOpacity}
    />
  );
});

export default OpenWorldLabel;
