import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mixHex, openWorldDayMix, seededRand } from './openWorldConstants';
import { useOpenWorldPalette } from './OpenWorldPaletteContext';

const CLOUD_BANK_SPAN = 620;
const CLOUD_BANK_COPIES = [-CLOUD_BANK_SPAN, 0, CLOUD_BANK_SPAN];
const CLOUD_DRIFT_SPEED = 0.75;
const cloudTransform = new THREE.Object3D();

function clusterCount(settings) {
  if (settings?.effectiveTier === 'low') return 4;
  if (settings?.effectiveTier === 'medium') return 7;
  if (settings?.effectiveTier === 'ultra') return 13;
  return 10;
}

function createCloudPuffs(count) {
  const rand = seededRand(7421);
  const puffs = [];

  for (let cluster = 0; cluster < count; cluster += 1) {
    const center = {
      x: -CLOUD_BANK_SPAN / 2 + rand() * CLOUD_BANK_SPAN,
      y: 38 + rand() * 36,
      z: -250 + rand() * 500,
    };
    const puffCount = 3 + Math.floor(rand() * 3);
    const clusterScale = 2.4 + rand() * 3.4;

    for (let puff = 0; puff < puffCount; puff += 1) {
      const centerPuff = puff === 0;
      const angle = rand() * Math.PI * 2;
      const spread = centerPuff ? 0 : (0.7 + rand() * 1.45) * clusterScale;
      const scale = clusterScale * (centerPuff ? 1 : 0.52 + rand() * 0.44);
      puffs.push({
        position: [
          center.x + Math.cos(angle) * spread,
          center.y + (centerPuff ? 0.8 : (rand() - 0.58) * clusterScale * 0.44),
          center.z + Math.sin(angle) * spread * 0.58,
        ],
        rotation: [rand() * 0.22, rand() * Math.PI * 2, rand() * 0.16],
        scale: [scale * (1.25 + rand() * 0.5), scale * (0.48 + rand() * 0.24), scale],
      });
    }
  }

  return puffs;
}

function writeCloudMatrices(mesh, puffs) {
  if (!mesh || typeof mesh.setMatrixAt !== 'function') return;
  puffs.forEach((puff, index) => {
    cloudTransform.position.set(...puff.position);
    cloudTransform.rotation.set(...puff.rotation);
    cloudTransform.scale.set(...puff.scale);
    cloudTransform.updateMatrix();
    mesh.setMatrixAt(index, cloudTransform.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere?.();
}

export default function OpenWorldClouds({ settings }) {
  const { accent, lowPoly, surface } = useOpenWorldPalette();
  const driftRef = useRef();
  const meshRefs = useRef([]);
  const puffs = useMemo(() => createCloudPuffs(clusterCount(settings)), [settings?.effectiveTier]);
  const dayMix = openWorldDayMix(settings);
  const cloudColor = mixHex(mixHex('#8290a6', accent, 0.08), '#f7fbff', 0.68 + dayMix * 0.22);

  useLayoutEffect(() => {
    meshRefs.current.forEach((mesh) => writeCloudMatrices(mesh, puffs));
  }, [puffs]);

  useFrame(({ clock }) => {
    if (!driftRef.current || !lowPoly) return;
    driftRef.current.position.x = (clock.getElapsedTime() * CLOUD_DRIFT_SPEED) % CLOUD_BANK_SPAN;
  });

  if (!lowPoly) return null;

  return (
    <group ref={driftRef}>
      {CLOUD_BANK_COPIES.map((offset, index) => (
        <instancedMesh
          key={offset}
          ref={(mesh) => { meshRefs.current[index] = mesh; }}
          args={[undefined, undefined, puffs.length]}
          position={[offset, 0, 0]}
        >
          <icosahedronGeometry args={[1, 1]} />
          <meshStandardMaterial
            {...surface}
            color={cloudColor}
            roughness={1}
            metalness={0}
            transparent
            opacity={0.74}
            depthWrite={false}
          />
        </instancedMesh>
      ))}
    </group>
  );
}
