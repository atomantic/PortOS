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

function writeMatrices(ref, blades) {
  if (!ref.current || typeof ref.current.setMatrixAt !== 'function') return;
  blades.forEach((blade, index) => {
    dummy.position.set(blade.x, GRASS_BASE_Y + blade.height * 0.5, blade.z);
    dummy.rotation.set(0, blade.yaw, 0);
    dummy.scale.set(blade.width, blade.height, blade.width);
    dummy.updateMatrix();
    ref.current.setMatrixAt(index, dummy.matrix);
  });
  if (ref.current.instanceMatrix) {
    ref.current.instanceMatrix.needsUpdate = true;
  }
}

export default function OpenWorldGrass({ settings }) {
  const { accent, surface, lowPoly } = useOpenWorldPalette();
  const count = grassCount(settings);
  const blades = useMemo(() => createBlades(count), [count]);
  const ref = useRef();
  const grassColor = mixHex('#4f8a5d', accent, 0.16);
  const timeUniformRef = useRef({ value: 0 });

  useLayoutEffect(() => {
    writeMatrices(ref, blades);
  }, [blades]);

  const onBeforeCompile = useMemo(() => (shader) => {
    shader.uniforms.uGrassTime = timeUniformRef.current;
    shader.vertexShader = `
      uniform float uGrassTime;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
      #include <begin_vertex>
      // Cone geometry height 1 is centered at y=0, so base is at -0.5 and tip is at +0.5.
      float bladeHeightNorm = clamp(position.y + 0.5, 0.0, 1.0);
      float sway = bladeHeightNorm * bladeHeightNorm;
      
      // Instance world position from 4th column of instanceMatrix
      vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      
      float gust = sin(uGrassTime * 0.75 + instPos.x * 0.05 + instPos.z * 0.04) * 0.32
                 + sin(uGrassTime * 1.6 + instPos.x * 0.12) * 0.1;
      
      transformed.x += gust * 0.38 * sway;
      transformed.z += gust * 0.62 * sway;
      `
    );
  }, []);

  useFrame(({ clock }) => {
    if (lowPoly && blades.length > 0) {
      timeUniformRef.current.value = clock.getElapsedTime();
    }
  });

  if (!lowPoly || blades.length === 0) return null;

  return (
    <instancedMesh key={blades.length} ref={ref} args={[undefined, undefined, blades.length]} frustumCulled={false}>
      <coneGeometry args={[0.12, 1, 3]} />
      <meshStandardMaterial
        {...surface}
        color={grassColor}
        roughness={1}
        metalness={0}
        onBeforeCompile={onBeforeCompile}
      />
    </instancedMesh>
  );
}
