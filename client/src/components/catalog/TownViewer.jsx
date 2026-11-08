import { Suspense, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Html, MapControls } from '@react-three/drei';
import { GreyboxModel, PartMesh } from './GreyboxViewer.jsx';
import ErrorBoundary from '../ErrorBoundary';
import { partColor } from '../../lib/greybox';
import { townFill, townSkyAt } from '../../../../server/lib/townMap.js';

const rad = (deg) => (deg * Math.PI) / 180;
const noop = () => {};
const GROUND = '#3a3f37';
const PAVING = { road: '#2b2d31', path: '#77716a', track: '#6b5a44' };
const latestModel = (media = []) => media.filter((row) => row.kind === 'model' && !row.deleted)
  .reduce((latest, row) => !latest || (row.createdAt || '') > (latest.createdAt || '') ? row : latest, null);

// Many boxes of one color as one draw call; a town has thousands of filler houses.
function BoxInstances({ items, color, emissive = null }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    items.forEach((item, i) => {
      q.setFromAxisAngle(up, rad(item.rotationDegrees || 0));
      m.compose(new THREE.Vector3(...item.position), q, new THREE.Vector3(...item.size));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={ref} args={[null, null, items.length]} key={items.length}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} roughness={1} emissive={emissive || '#000000'} emissiveIntensity={emissive ? 1 : 0} />
    </instancedMesh>
  );
}

// A set's greybox where the town places it: its parts, or its Blender model.
function PlacedSet({ set, entry, labelPortal }) {
  const greybox = entry?.ingredient?.payload?.greybox || null;
  const model = greybox?.source === 'glb' ? latestModel(entry.media) : null;
  return (
    <group position={[set.position[0], 0, set.position[1]]} rotation={[0, rad(set.rotationDegrees), 0]}>
      {greybox?.source === 'glb' && model && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}><GreyboxModel src={`/data/models/${encodeURIComponent(model.mediaKey)}`} onReady={noop} /></Suspense>
        </ErrorBoundary>
      )}
      {greybox && greybox.source !== 'glb' && (greybox.parts || []).map((part) => <PartMesh key={part.id} part={part} color={partColor(greybox, part)} />)}
      {!greybox && <mesh position={[0, 1.5, 0]}><boxGeometry args={[20, 3, 20]} /><meshStandardMaterial color="#8a5a3c" wireframe /></mesh>}
      <Html portal={labelPortal} position={[0, 12, 0]} center style={{ pointerEvents: 'none' }}>
        <span className="port-media-overlay-strong whitespace-nowrap rounded px-1 text-[10px]">{entry?.ingredient?.name || 'Missing environment'}</span>
      </Html>
    </group>
  );
}

/**
 * The whole town in 3D: ground, streets, generated filler, and every placed
 * set's own greybox, lit for `clockMinutes` (sky, sun, lamps). Pan, zoom and
 * tilt with the map controls. `places` is the loaded catalog places by id.
 */
export default function TownViewer({ town, places, clockMinutes = 21 * 60 }) {
  const labelPortal = useRef(null);
  const fill = useMemo(() => townFill(town), [town]);
  const sky = townSkyAt(clockMinutes);
  const extent = useMemo(() => {
    const points = [...town.sets.map((set) => set.position), ...town.streets.flatMap((street) => street.points)];
    if (!points.length) return { center: [0, 0], size: 200 };
    const xs = points.map((p) => p[0]);
    const zs = points.map((p) => p[1]);
    const center = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
    return { center, size: Math.max(200, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) };
  }, [town]);
  const sunDir = [
    Math.sin(rad(sky.sunAzimuth)) * Math.cos(rad(sky.sunElevation)),
    Math.max(0.05, Math.sin(rad(sky.sunElevation))),
    -Math.cos(rad(sky.sunAzimuth)) * Math.cos(rad(sky.sunElevation)),
  ];
  const pavingBy = (kind) => fill.paving.filter((strip) => strip.kind === kind);
  const lampHeads = fill.lamps.map((lamp) => ({ position: [lamp.position[0], 5, lamp.position[2]], size: [0.5, 0.25, 0.5], rotationDegrees: 0 }));
  const lampPoles = fill.lamps.map((lamp) => ({ position: [lamp.position[0], 2.5, lamp.position[2]], size: [0.15, 5, 0.15], rotationDegrees: 0 }));
  const [cx, cz] = extent.center;
  return (
    <div ref={labelPortal} className="relative w-full overflow-hidden rounded-lg border border-port-border bg-black" style={{ aspectRatio: '16 / 10' }} data-port-graphics-surface="webgl" data-testid="town-viewer">
      <Canvas camera={{ position: [cx, extent.size * 0.6, cz + extent.size * 0.6], fov: 45, near: 0.5, far: 20000 }} dpr={[1, 2]} frameloop="demand">
        <color attach="background" args={[sky.sky]} />
        <fog attach="fog" args={[sky.sky, extent.size * 1.2, extent.size * 4]} />
        <ambientLight intensity={sky.ambient} />
        <hemisphereLight args={[sky.sky, '#222018', sky.ambient * 0.6]} />
        {sky.sunIntensity > 0 && <directionalLight position={sunDir.map((v) => v * 500)} intensity={sky.sunIntensity} />}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]}>
          <planeGeometry args={[extent.size * 6, extent.size * 6]} />
          <meshStandardMaterial color={GROUND} roughness={1} />
        </mesh>
        {Object.keys(PAVING).map((kind) => <BoxInstances key={kind} items={pavingBy(kind)} color={PAVING[kind]} />)}
        <BoxInstances items={fill.fields} color="#5d6b3a" />
        <BoxInstances items={fill.houses} color="#9a958c" />
        <BoxInstances items={fill.fences} color="#6e6a62" />
        <BoxInstances items={lampPoles} color="#4a4d52" />
        <BoxInstances items={lampHeads} color="#30302a" emissive={sky.lampsOn ? '#ffd58a' : null} />
        {town.sets.map((set) => <PlacedSet key={set.id} set={set} entry={places[set.ingredientId]} labelPortal={labelPortal} />)}
        <MapControls makeDefault target={[cx, 0, cz]} maxPolarAngle={Math.PI * 0.49} />
      </Canvas>
    </div>
  );
}
