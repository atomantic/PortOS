import { useMemo } from 'react';
import * as THREE from 'three';

// A thin glowing connector rendered as a native-three tube along a curve through `points`.
// Used for CyberCity's light bridges (memory district) and goal-tree links. We deliberately do
// NOT use drei's <Line>: it builds a three-stdlib Line2 whose fat-line geometry needs
// `computeLineDistances`, and the bundled three-stdlib instance mismatches the app's three
// (0.182), so that method is missing on the reconciled object and the whole Canvas crashes
// ("m.computeLineDistances is not a function"). A TubeGeometry needs none of that, gives real
// width (native LineBasicMaterial ignores linewidth anyway), and reads better as a glow.
export default function CityTubeLine({ points, color, radius = 0.08, opacity = 0.5, segments = 24 }) {
  const geometry = useMemo(() => {
    const pts = (points || []).filter(Boolean).map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    if (pts.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(pts);
    // Tubular segments scale with point count so a multi-point arc stays smooth.
    return new THREE.TubeGeometry(curve, Math.max(segments, pts.length * 8), radius, 6, false);
  }, [points, radius, segments]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry}>
      <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} />
    </mesh>
  );
}
