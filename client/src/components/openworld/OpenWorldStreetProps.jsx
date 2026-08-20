import { useMemo, useLayoutEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { openWorldDayMix, openWorldShowDetail, mixHex } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { computeStreets, computeStreetProps } from '../../utils/openWorldPlan';

// Street furniture from the master plan: lamp posts pooling light along every street and
// planting trees ringing the AI Core plaza. Everything is instanced, so lamp count does not
// multiply the scene's draw calls. Lamp light pools are faked with emissive heads + additive
// ground discs (the city's established no-real-point-lights pattern).
// The Vibes silhouettes remain on the low tier; Cyber keeps the older detail gate because its
// neon dressing is much heavier and the grove is already enough orientation at that tier.

const dummy = new THREE.Object3D();

// Module-scope position offsets — stable identities so the matrix-writing effect below
// runs only when placements actually change, not on every parent re-render.
const POLE_POS = [0, 1.7, 0];
const HEAD_POS = [0, 3.45, 0];
const HEAD_CORE_POS = [0, 3.45, 0];
const HEAD_CAP_POS = [0, 3.75, 0];
const POOL_POS = [0, 0.035, 0];
const TRUNK_POS = [0, 0.55, 0];
const CANOPY_POS = [0, 1.55, 0];
const CANOPY_TOP_POS = [0, 2.12, 0, 0.72];

// One instanced mesh whose matrices are written once from `placements`. `flat` lays the
// geometry into the ground plane (used by the light-pool discs).
function writeMatrices(ref, placements, position, flat, sway, time = 0) {
  if (!ref.current) return;
  const scaleMultiplier = position[3] ?? 1;
  placements.forEach((p, i) => {
    const phase = p.seed ?? i;
    const gust = sway
      ? Math.sin(time * 0.72 + phase * 1.7 + p.x * 0.04 + p.z * 0.03) * 0.035
        + Math.sin(time * 1.21 + phase * 0.63) * 0.016
      : 0;
    dummy.position.set(p.x + position[0], position[1], p.z + position[2]);
    dummy.rotation.set(flat ? -Math.PI / 2 : gust * 0.6, !flat && p.seed != null ? (p.seed * 1.7) % (Math.PI * 2) : 0, flat ? 0 : gust);
    dummy.scale.setScalar((p.scale ?? 1) * scaleMultiplier);
    dummy.updateMatrix();
    ref.current.setMatrixAt(i, dummy.matrix);
  });
  ref.current.instanceMatrix.needsUpdate = true;
}

function Instances({ placements, geometry, geometryArgs, position, flat = false, sway = false, children }) {
  const ref = useRef();
  useLayoutEffect(() => {
    writeMatrices(ref, placements, position, flat, sway);
    if (sway && ref.current) ref.current.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, [placements, position, flat, sway]);

  useFrame(({ clock }) => {
    if (sway) writeMatrices(ref, placements, position, flat, true, clock.getElapsedTime());
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, placements.length]} frustumCulled={false}>
      {geometry === 'cylinder' && <cylinderGeometry args={geometryArgs} />}
      {geometry === 'sphere' && <sphereGeometry args={geometryArgs} />}
      {geometry === 'circle' && <circleGeometry args={geometryArgs} />}
      {geometry === 'icosahedron' && <icosahedronGeometry args={geometryArgs} />}
      {geometry === 'box' && <boxGeometry args={geometryArgs} />}
      {children}
    </instancedMesh>
  );
}

export default function OpenWorldStreetProps({ settings }) {
  const { accent, tintStructure, lowPoly, surface } = useOpenWorldPalette();
  const dayMix = openWorldDayMix(settings);
  const density = settings?.particleDensity ?? 1;

  const props = useMemo(() => {
    const streets = computeStreets();
    return computeStreetProps(streets, density);
  }, [density]);

  // Keep the plaza grove even on the low tier: it is cheap, anchors the center of the map,
  // and gives the bright world a sense of scale. Lamps and their additive pools remain detail-only.
  const showLamps = lowPoly || openWorldShowDetail(settings);
  if (!showLamps && props.trees.length === 0) return null;

  const lampGlow = mixHex(accent, '#ffe2a6', 0.58);
  const headOpacity = 0.95 * (1 - dayMix) + 0.4 * dayMix; // lamps rest by day
  const poolOpacity = 0.1 * (1 - dayMix); // light pools are a night thing
  const structureColor = lowPoly
    ? mixHex('#3e5a5f', accent, 0.18)
    : tintStructure('#141b2c');
  const foliageColor = mixHex(mixHex('#6fa37f', accent, 0.22), '#d5bd83', dayMix * 0.18);

  return (
    <group>
      {showLamps && (
        <>
          {/* Lamp poles */}
          <Instances placements={props.lamps} geometry="cylinder" geometryArgs={[0.05, 0.08, 3.4, 6]} position={POLE_POS}>
            <meshStandardMaterial {...surface} color={structureColor} roughness={0.7} metalness={lowPoly ? 0 : 0.45} />
          </Instances>
          {/* Faceted lantern housings + warm cores: a stronger silhouette than a bare orb,
              while still keeping the city's no-point-light performance budget. */}
          <Instances placements={props.lamps} geometry="box" geometryArgs={[0.48, 0.5, 0.48]} position={HEAD_POS}>
            <meshStandardMaterial {...surface} color={structureColor} roughness={0.65} metalness={lowPoly ? 0 : 0.35} />
          </Instances>
          <Instances placements={props.lamps} geometry="box" geometryArgs={[0.29, 0.31, 0.29]} position={HEAD_CORE_POS}>
            <meshBasicMaterial color={lampGlow} transparent opacity={headOpacity} toneMapped={false} />
          </Instances>
          <Instances placements={props.lamps} geometry="box" geometryArgs={[0.58, 0.07, 0.58]} position={HEAD_CAP_POS}>
            <meshStandardMaterial {...surface} color={structureColor} roughness={0.7} metalness={lowPoly ? 0 : 0.4} />
          </Instances>
          {/* Faked light pools on the pavement */}
          {poolOpacity > 0.005 && (
            <Instances placements={props.lamps} geometry="circle" geometryArgs={[1.7, 16]} position={POOL_POS} flat>
              <meshBasicMaterial
                color={lampGlow}
                transparent
                opacity={poolOpacity}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
              />
            </Instances>
          )}
        </>
      )}
      {/* Tree trunks around the plaza */}
      <Instances placements={props.trees} geometry="cylinder" geometryArgs={[0.07, 0.1, 1.1, 5]} position={TRUNK_POS}>
        <meshStandardMaterial {...surface} color={structureColor} roughness={0.8} />
      </Instances>
      {/* Vibes uses two broad faceted leaf layers so the grove reads as trees rather than
          floating gems; Cyber keeps the established wireframe treatment. */}
      {lowPoly ? (
        <>
          <Instances placements={props.trees} geometry="sphere" geometryArgs={[0.9, 8, 5]} position={CANOPY_POS} sway>
            <meshStandardMaterial {...surface} color={foliageColor} roughness={0.98} />
          </Instances>
          <Instances placements={props.trees} geometry="sphere" geometryArgs={[0.68, 8, 5]} position={CANOPY_TOP_POS} sway>
            <meshStandardMaterial {...surface} color={mixHex(foliageColor, '#d5e7a4', 0.28)} roughness={0.98} />
          </Instances>
        </>
      ) : (
        <Instances placements={props.trees} geometry="icosahedron" geometryArgs={[0.8, 1]} position={CANOPY_POS} sway>
          <meshBasicMaterial
            color={mixHex(accent, '#22c55e', 0.45)}
            wireframe
            transparent
            opacity={0.5 * (1 - dayMix) + 0.3 * dayMix}
            toneMapped={false}
          />
        </Instances>
      )}
    </group>
  );
}
