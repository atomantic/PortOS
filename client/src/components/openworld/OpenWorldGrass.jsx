import { useMemo, useLayoutEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mixHex, openWorldShowDetail, seededRand } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';
import { NATURE_PATCHES } from './OpenWorldNature';
import { WORLD } from '../../utils/openWorldPlan';

// Grass is placed in small readable meadows rather than across every square metre. That
// keeps the low-poly look intentional, protects the road silhouettes, and gives the rover
// a visual reason to leave the paved arrival lane and explore the edges of town.
const GRASS_FIELDS = [
  { id: 'arrival-west', position: [-24, 0, 44], radius: 8.5 },
  { id: 'arrival-east', position: [24, 0, 44], radius: 8.5 },
  { id: 'west-greenway', position: [-45, 0, 20], radius: 7.5 },
  { id: 'east-greenway', position: [45, 0, 20], radius: 7.5 },
  { id: 'memory-edge', position: [-54, 0, -31], radius: 6.5 },
  { id: 'goal-edge', position: [52, 0, -39], radius: 7 },
  { id: 'shoreline-west', position: [-31, 0, -51], radius: 6 },
  { id: 'shoreline-east', position: [31, 0, -51], radius: 6 },
  ...NATURE_PATCHES.map((patch) => ({
    id: patch.id,
    position: patch.position,
    radius: 2.4 + patch.scale * 1.7,
  })),
];

const dummy = new THREE.Object3D();
const GRASS_BASE_Y = WORLD.groundY + 0.08;

function grassCount(settings) {
  // Keep a small signature patch on the low tier. Adaptive quality may downshift on
  // integrated GPUs, but the Vibes world should still read as a windy meadow rather
  // than a bare debug plane.
  if (settings?.effectiveTier === 'low') return 140;
  if (!openWorldShowDetail(settings)) return 0;
  if (settings?.effectiveTier === 'ultra') return 680;
  if (settings?.effectiveTier === 'medium') return 320;
  return 520;
}

function createBlades(count) {
  const rand = seededRand(9117);
  return Array.from({ length: count }, (_, index) => {
    const field = GRASS_FIELDS[index % GRASS_FIELDS.length];
    const angle = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * field.radius;
    return {
      x: field.position[0] + Math.cos(angle) * radius,
      z: field.position[2] + Math.sin(angle) * radius,
      height: 0.42 + rand() * 0.5,
      width: 0.7 + rand() * 0.42,
      yaw: rand() * Math.PI * 2,
      phase: rand() * Math.PI * 2,
    };
  });
}

function writeMatrices(ref, blades, time = 0) {
  if (!ref.current) return;
  blades.forEach((blade, index) => {
    const gust = Math.sin(time * 0.62 + blade.x * 0.045 + blade.z * 0.032 + blade.phase) * 0.22
      + Math.sin(time * 1.45 + blade.phase * 0.7) * 0.07;
    const height = blade.height * (1 + Math.sin(blade.phase * 1.3) * 0.08);
    dummy.position.set(blade.x, GRASS_BASE_Y + height * 0.5, blade.z);
    // A triangular blade leans in two axes so the field reads as a moving volume, not
    // as one synchronized sheet. The phase is deterministic, but the wind is shared.
    dummy.rotation.set(gust * 0.36, blade.yaw, gust * 0.58);
    dummy.scale.set(blade.width, height, blade.width);
    dummy.updateMatrix();
    ref.current.setMatrixAt(index, dummy.matrix);
  });
  ref.current.instanceMatrix.needsUpdate = true;
}

export default function OpenWorldGrass({ settings }) {
  const { accent, surface, lowPoly } = useOpenWorldPalette();
  const count = grassCount(settings);
  const blades = useMemo(() => createBlades(count), [count]);
  const ref = useRef();
  const grassColor = mixHex('#4f8a5d', accent, 0.16);

  useLayoutEffect(() => {
    writeMatrices(ref, blades);
    if (ref.current) ref.current.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, [blades]);

  useFrame(({ clock }) => {
    if (lowPoly && blades.length > 0) writeMatrices(ref, blades, clock.getElapsedTime());
  });

  if (!lowPoly || blades.length === 0) return null;

  return (
    <instancedMesh key={blades.length} ref={ref} args={[undefined, undefined, blades.length]} frustumCulled={false}>
      <coneGeometry args={[0.12, 1, 3]} />
      <meshStandardMaterial {...surface} color={grassColor} roughness={1} metalness={0} />
    </instancedMesh>
  );
}
