import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Html, MapControls } from '@react-three/drei';
import { GreyboxModel, PartMesh } from './GreyboxViewer.jsx';
import ErrorBoundary from '../ErrorBoundary';
import { partColor } from '../../lib/greybox';
import { worldFill, worldSkyAt } from '../../../../server/lib/worldMap.js';

const rad = (deg) => (deg * Math.PI) / 180;
const noop = () => {};
const GROUND = '#3a3f37';
const PAVING = { road: '#2b2d31', footpath: '#77716a', track: '#6b5a44', corridor: '#55595f' };
const latestModel = (media = []) => media.filter((row) => row.kind === 'model' && !row.deleted)
  .reduce((latest, row) => !latest || (row.createdAt || '') > (latest.createdAt || '') ? row : latest, null);

// Many boxes of one color as one draw call; a world has thousands of filler buildings.
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

// Every wire as one line draw call: primaries pole to pole and service drops to roof masts.
function Wires({ segments }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segments.flat(), 3));
    return g;
  }, [segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!segments.length) return null;
  return <lineSegments geometry={geometry}><lineBasicMaterial color="#1c1c1c" /></lineSegments>;
}

// A set's greybox where the world places it: its parts, or its Blender model.
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

/** The world's extent on the ground: its middle and a size that covers every set and path. */
export function worldExtent(world) {
  const points = [...world.sets.map((set) => set.position), ...world.paths.flatMap((path) => path.points)];
  if (!points.length) return { center: [0, 0], size: 200 };
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const center = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  return { center, size: Math.max(200, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) };
}

/**
 * Everything of the world inside a Canvas: sky and light for its setting and
 * `clockMinutes`, ground, paths, generated filler, lamps and every placed set.
 * Shared by the World tab's viewer and the previz player's timeline shots.
 */
export function WorldScene({ world, places, clockMinutes, labelPortal }) {
  const fill = useMemo(() => worldFill(world), [world]);
  const extent = useMemo(() => worldExtent(world), [world]);
  const setting = world.setting || 'outdoor';
  const sky = worldSkyAt(clockMinutes, setting);
  const sunDir = [
    Math.sin(rad(sky.sunAzimuth)) * Math.cos(rad(sky.sunElevation)),
    Math.max(0.05, Math.sin(rad(sky.sunElevation))),
    -Math.cos(rad(sky.sunAzimuth)) * Math.cos(rad(sky.sunElevation)),
  ];
  const pavingBy = (kind) => fill.paving.filter((strip) => strip.kind === kind);
  const [cx, cz] = extent.center;
  return (
    <>
      <color attach="background" args={[sky.sky]} />
      {setting !== 'space' && <fog attach="fog" args={[sky.sky, extent.size * 1.2, extent.size * 4]} />}
      <ambientLight intensity={sky.ambient} />
      <hemisphereLight args={[sky.sky, '#222018', sky.ambient * 0.6]} />
      {sky.sunIntensity > 0 && <directionalLight position={sunDir.map((v) => v * 500)} intensity={sky.sunIntensity} />}
      {/* Space has no ground: the sets float where they are placed. */}
      {setting !== 'space' && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]}>
          <planeGeometry args={[extent.size * 6, extent.size * 6]} />
          <meshStandardMaterial color={setting === 'indoor' ? '#2c2e33' : GROUND} roughness={1} />
        </mesh>
      )}
      {Object.keys(PAVING).map((kind) => <BoxInstances key={kind} items={pavingBy(kind)} color={PAVING[kind]} />)}
      <BoxInstances items={fill.open} color="#5d6b3a" />
      <BoxInstances items={fill.buildings} color="#9a958c" />
      <BoxInstances items={fill.fences} color="#6e6a62" />
      <BoxInstances items={fill.driveways} color="#4d4f52" />
      <BoxInstances items={fill.doors} color="#3a2e26" />
      <BoxInstances items={fill.poles} color="#4a4038" />
      <BoxInstances items={fill.arms} color="#4a4038" />
      <BoxInstances items={fill.lamps} color="#30302a" emissive={sky.lampsOn ? '#ffd58a' : null} />
      <Wires segments={fill.wires} />
      {world.sets.map((set) => <PlacedSet key={set.id} set={set} entry={places[set.ingredientId]} labelPortal={labelPortal} />)}
    </>
  );
}

/**
 * The whole world in 3D (WorldScene), lit for its setting and, outdoors,
 * `clockMinutes`. Pan, zoom and tilt with the map controls. `places` is the
 * loaded catalog places by id.
 */
export default function WorldViewer({ world, places, clockMinutes = 21 * 60 }) {
  const labelPortal = useRef(null);
  const extent = useMemo(() => worldExtent(world), [world]);
  const [cx, cz] = extent.center;
  return (
    <div ref={labelPortal} className="relative w-full overflow-hidden rounded-lg border border-port-border bg-black" style={{ aspectRatio: '16 / 10' }} data-port-graphics-surface="webgl" data-testid="world-viewer">
      <Canvas camera={{ position: [cx, extent.size * 0.6, cz + extent.size * 0.6], fov: 45, near: 0.5, far: 20000 }} dpr={[1, 2]} frameloop="demand">
        <WorldScene world={world} places={places} clockMinutes={clockMinutes} labelPortal={labelPortal} />
        <MapControls makeDefault target={[cx, 0, cz]} maxPolarAngle={Math.PI * 0.49} />
      </Canvas>
    </div>
  );
}
