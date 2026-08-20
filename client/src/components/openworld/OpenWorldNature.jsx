import { mixHex, openWorldDayMix, openWorldShowDetail } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';

// The playable city uses plants as wayfinding language: arrival gardens sit beside the
// southern entry road, district greens soften the outer parcels, and warp-pad planters frame
// an interaction surface. These are grounded, broad silhouettes rather than floating ornaments.
export const NATURE_PATCHES = [
  { id: 'arrival-west', position: [-10, 0, 48], scale: 1.15, variant: 0 },
  { id: 'arrival-east', position: [10, 0, 48], scale: 1.15, variant: 1 },
  { id: 'plaza-southwest', position: [-14, 0, 18], scale: 0.9, variant: 1 },
  { id: 'plaza-southeast', position: [14, 0, 18], scale: 0.9, variant: 0 },
  { id: 'productivity-greenway', position: [-43, 0, 20], scale: 1.1, variant: 2 },
  { id: 'wellness-greenway', position: [43, 0, 20], scale: 1.1, variant: 1 },
  { id: 'memory-garden', position: [-39, 0, -19], scale: 1.05, variant: 2 },
  { id: 'goals-garden', position: [29, 0, -29], scale: 1.05, variant: 0 },
  { id: 'archive-garden', position: [-14, 0, 46], scale: 0.85, variant: 2 },
  { id: 'quiet-garden', position: [-48, 0, 38], scale: 1.15, variant: 0 },
];

const LEAF_LAYOUTS = [
  [
    { position: [0, 0.96, 0], scale: [0.54, 0.68, 0.54] },
    { position: [-0.34, 0.72, 0.14], scale: [0.38, 0.42, 0.38] },
    { position: [0.35, 0.78, -0.1], scale: [0.42, 0.5, 0.42] },
  ],
  [
    { position: [0, 1.04, 0], scale: [0.48, 0.72, 0.48] },
    { position: [-0.28, 0.74, -0.16], scale: [0.42, 0.5, 0.42] },
    { position: [0.3, 0.69, 0.16], scale: [0.36, 0.45, 0.36] },
  ],
  [
    { position: [0, 0.9, 0], scale: [0.62, 0.5, 0.62] },
    { position: [-0.42, 0.76, 0.08], scale: [0.4, 0.55, 0.4] },
    { position: [0.38, 0.8, -0.08], scale: [0.4, 0.5, 0.4] },
  ],
];

const FLOWER_LAYOUT = [
  { position: [0.22, 1.45, 0.16], scale: 1 },
  { position: [-0.3, 1.23, -0.18], scale: 0.82 },
  { position: [0.38, 1.25, -0.08], scale: 0.76 },
];

function Plant({ position, scale = 1, variant = 0, flowerColor, foliageColor, foliageDark, cyber }) {
  const leaves = LEAF_LAYOUTS[variant % LEAF_LAYOUTS.length];
  const stemColor = mixHex(foliageDark, '#b29368', cyber ? 0.08 : 0.28);
  const leafGlow = mixHex(foliageColor, '#173b25', cyber ? 0.1 : 0.56);

  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.42, 0]}>
        <cylinderGeometry args={[0.045, 0.08, 0.82, 6]} />
        {cyber ? (
          <meshBasicMaterial color={foliageColor} transparent opacity={0.8} wireframe />
        ) : (
          <meshStandardMaterial color={stemColor} roughness={0.95} metalness={0} />
        )}
      </mesh>
      {leaves.map((leaf, index) => (
        <mesh key={`leaf-${index}`} position={leaf.position} scale={leaf.scale} rotation={[0, index * 0.9, index * 0.15]}>
          <icosahedronGeometry args={[1, 1]} />
          {cyber ? (
            <meshBasicMaterial color={foliageColor} transparent opacity={0.34} wireframe toneMapped={false} />
          ) : (
            <meshStandardMaterial
              color={index === 0 ? foliageColor : foliageDark}
              emissive={leafGlow}
              emissiveIntensity={0.18}
              roughness={0.98}
              metalness={0}
            />
          )}
        </mesh>
      ))}
      {FLOWER_LAYOUT.map((flower, index) => (
        <mesh key={`flower-${index}`} position={flower.position} scale={flower.scale}>
          <sphereGeometry args={[0.16, 8, 6]} />
          <meshBasicMaterial color={flowerColor} transparent opacity={cyber ? 0.9 : 0.88} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

export function PlantCluster({ position = [0, 0, 0], scale = 1, variant = 0, container = false, dayMix = 0 }) {
  const { accent, lowPoly, tintStructure } = useOpenWorldPalette();
  const cyber = !lowPoly;
  const foliageColor = mixHex(lowPoly ? '#5f9b6d' : '#20b7a5', accent, lowPoly ? 0.14 : 0.56);
  const foliageDark = mixHex(foliageColor, lowPoly ? '#214934' : '#071c25', lowPoly ? 0.42 : 0.7);
  const flowerColor = mixHex(mixHex(accent, '#ffd166', lowPoly ? 0.45 : 0.18), '#fff3c4', dayMix * 0.2);

  return (
    <group position={position} scale={scale}>
      {container && (
        <>
          <mesh position={[0, 0.15, 0]}>
            <cylinderGeometry args={[0.78, 0.88, 0.3, 8]} />
            <meshStandardMaterial color={tintStructure('#263938')} roughness={0.9} metalness={cyber ? 0.35 : 0} />
          </mesh>
          <mesh position={[0, 0.31, 0]}>
            <cylinderGeometry args={[0.64, 0.68, 0.05, 8]} />
            <meshStandardMaterial color={mixHex(foliageDark, '#111c1b', 0.35)} roughness={1} metalness={0} />
          </mesh>
        </>
      )}
      <Plant position={[-0.36, container ? 0.28 : 0, 0]} scale={0.82} variant={variant} flowerColor={flowerColor} foliageColor={foliageColor} foliageDark={foliageDark} cyber={cyber} />
      <Plant position={[0.34, container ? 0.28 : 0, 0.08]} scale={0.68} variant={variant + 1} flowerColor={flowerColor} foliageColor={foliageColor} foliageDark={foliageDark} cyber={cyber} />
      <Plant position={[0, container ? 0.28 : 0, -0.28]} scale={0.72} variant={variant + 2} flowerColor={flowerColor} foliageColor={foliageColor} foliageDark={foliageDark} cyber={cyber} />
    </group>
  );
}

export default function OpenWorldNature({ settings }) {
  const dayMix = openWorldDayMix(settings);
  const detailed = openWorldShowDetail(settings);
  const patches = detailed ? NATURE_PATCHES : NATURE_PATCHES.slice(0, 4);

  return (
    <group>
      {patches.map((patch) => (
        <PlantCluster key={patch.id} position={patch.position} scale={patch.scale * (detailed ? 1 : 0.86)} variant={patch.variant} dayMix={dayMix} />
      ))}
    </group>
  );
}
