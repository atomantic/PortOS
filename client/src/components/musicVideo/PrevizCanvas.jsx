import { Suspense, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { GreyboxModel, PartMesh } from '../catalog/GreyboxViewer.jsx';
import { WorldScene } from '../catalog/WorldViewer.jsx';
import ErrorBoundary from '../ErrorBoundary';
import { GREYBOX_SKY_COLOR } from '../../../../server/lib/greyboxVocabulary.js';
import { aspectRatio, fovFromFocalLength, partColor } from '../../lib/greybox';

const FIGURE_HEIGHT = 1.7;
const rad = (deg) => (deg * Math.PI) / 180;
const noop = () => {};

// Body height and ground lift of each pose; a rider sits on the vehicle frame, a sitter on a seat block, a crouch is a short capsule.
const POSE_BODY = {
  stand: { body: FIGURE_HEIGHT, lift: 0 },
  walk: { body: FIGURE_HEIGHT, lift: 0 },
  run: { body: FIGURE_HEIGHT, lift: 0, lean: 0.35 },
  crouch: { body: 1.0, lift: 0 },
  sit: { body: 1.1, lift: 0.45 },
  ride: { body: 1.1, lift: 0.55 },
};

// A person at their mark in their pawn color; the nose shows which way they face. Riding a vehicle, a two-wheeled frame in the vehicle's pawn color sits under a seated figure; a sitter has a seat block, a runner leans forward.
function ActorProxy({ actor, labelPortal }) {
  const riding = actor.pose === 'ride';
  const sitting = actor.pose === 'sit';
  const { body, lift, lean = 0 } = POSE_BODY[actor.pose] || POSE_BODY.stand;
  return (
    <group position={actor.position} rotation={[0, rad(actor.facingDegrees), 0]}>
      {riding && (
        // Two wheels and a thin frame: reads as a vehicle from ahead or behind, not as a plinth.
        <group>
          {[-0.65, 0.65].map((z) => (
            <mesh key={z} position={[0, 0.3, z]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.3, 0.3, 0.08, 20]} />
              <meshStandardMaterial color={actor.vehicleColor || actor.color} roughness={0.9} />
            </mesh>
          ))}
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[0.06, 0.06, 1.3]} />
            <meshStandardMaterial color={actor.vehicleColor || actor.color} roughness={0.9} />
          </mesh>
        </group>
      )}
      {sitting && (
        <mesh position={[0, lift / 2, 0]}>
          <boxGeometry args={[0.5, lift, 0.5]} />
          <meshStandardMaterial color="#8a8f99" roughness={0.9} />
        </mesh>
      )}
      <group position={[0, lift, riding ? -0.1 : 0]} rotation={[lean, 0, 0]}>
        <mesh position={[0, body / 2, 0]}>
          <capsuleGeometry args={[0.22, Math.max(body - 0.44, 0.01), 6, 16]} />
          <meshStandardMaterial color={actor.color} roughness={0.9} />
        </mesh>
        <mesh position={[0, body * 0.85, 0.28]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.07, 0.2, 12]} />
          <meshStandardMaterial color="#ffffff" />
        </mesh>
      </group>
      <Html portal={labelPortal} position={[0, lift + body + 0.25, 0]} center style={{ pointerEvents: 'none' }}>
        <span className="port-media-overlay-strong whitespace-nowrap rounded px-1 text-[10px]">{actor.name}</span>
      </Html>
    </group>
  );
}

// Puts the render camera on the cut's camera each time the frame moves; the canvas renders on demand.
function CameraRig({ camera: shot }) {
  const { camera, invalidate } = useThree();
  const [px, py, pz] = shot.position;
  const [tx, ty, tz] = shot.target;
  useEffect(() => {
    camera.position.set(px, py, pz);
    camera.lookAt(tx, ty, tz);
    camera.fov = fovFromFocalLength(shot.focalLengthMm);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, invalidate, px, py, pz, tx, ty, tz, shot.focalLengthMm]);
  return null;
}

/**
 * One previz frame (lib/musicVideoPreviz.js `previzFrameAt`) drawn over its
 * set's greybox, or over the whole world when the cut plays on the timeline: the layout, every visible person as a proxy, seen through the
 * cut's camera at its lens and aspect. `labelPortal` is the DOM overlay for names.
 */
export default function PrevizCanvas({ frame, modelSrc = null, labelPortal }) {
  const { greybox, camera } = frame;
  if (frame.world) {
    // A shot on the timeline: the whole world, lit by the story clock, from the cut's camera.
    return (
      <ErrorBoundary fallback={<p role="alert" className="p-4 text-sm text-port-text">The world could not be drawn.</p>}>
        <Canvas camera={{ position: camera.position, fov: fovFromFocalLength(camera.focalLengthMm), near: 0.1, far: 20000 }}
          gl={{ antialias: true, preserveDrawingBuffer: true }} dpr={[1, 2]} frameloop="demand" style={{ aspectRatio: aspectRatio(camera.aspect) }}>
          <WorldScene world={frame.world} places={frame.worldPlaces || {}} clockMinutes={frame.clockMinutes} labelPortal={labelPortal} />
          {frame.actors.filter((actor) => actor.visible).map((actor) => <ActorProxy key={actor.subjectId} actor={actor} labelPortal={labelPortal} />)}
          <CameraRig camera={camera} />
        </Canvas>
      </ErrorBoundary>
    );
  }
  const layout = { zones: greybox.zones || [] };
  return (
    <ErrorBoundary key={modelSrc || 'spec'} fallback={<p role="alert" className="p-4 text-sm text-port-text">The set's 3D model could not be drawn.</p>}>
      <Canvas
        camera={{ position: camera.position, fov: fovFromFocalLength(camera.focalLengthMm), near: 0.1, far: 2000 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        dpr={[1, 2]}
        frameloop="demand"
        style={{ aspectRatio: aspectRatio(camera.aspect) }}
      >
        <color attach="background" args={[GREYBOX_SKY_COLOR]} />
        <ambientLight intensity={0.9} />
        <hemisphereLight args={['#ffffff', '#555a66', 0.6]} />
        <directionalLight position={[10, 18, 8]} intensity={1.4} />
        {greybox.source === 'glb' && modelSrc && <Suspense fallback={null}><GreyboxModel src={modelSrc} onReady={noop} /></Suspense>}
        {greybox.source !== 'glb' && (greybox.parts || []).map((part) => <PartMesh key={part.id} part={part} color={partColor(layout, part)} />)}
        {frame.actors.filter((actor) => actor.visible).map((actor) => <ActorProxy key={actor.subjectId} actor={actor} labelPortal={labelPortal} />)}
        <CameraRig camera={camera} />
      </Canvas>
    </ErrorBoundary>
  );
}
