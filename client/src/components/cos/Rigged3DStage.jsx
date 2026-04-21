import { Suspense, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, ContactShadows } from '@react-three/drei';
import RiggedAvatarScene from './avatar3d/RiggedAvatarScene';

// Full-page stage view. User-controllable camera, environmental lighting,
// contact shadows — the rigged avatar's "showroom".
export default function Rigged3DStage({ url, state, speaking }) {
  const [caps, setCaps] = useState(null);

  return (
    <div className="relative w-full h-full min-h-[70vh] bg-port-bg">
      <Canvas
        camera={{ position: [0, 1.4, 2.6], fov: 30 }}
        dpr={[1, 2]}
        shadows
      >
        <ambientLight intensity={0.5} />
        <directionalLight
          position={[3, 5, 3]}
          intensity={1.1}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <Suspense fallback={null}>
          <RiggedAvatarScene
            url={url}
            state={state}
            speaking={speaking}
            onCapabilitiesReady={setCaps}
          />
          <Environment preset="studio" />
        </Suspense>
        <ContactShadows position={[0, 0, 0]} opacity={0.5} scale={10} blur={2.4} far={4} />
        <OrbitControls target={[0, 1.2, 0]} enablePan={false} minDistance={1.2} maxDistance={6} />
      </Canvas>
      {caps && <CapabilityBadge caps={caps} />}
    </div>
  );
}

function CapabilityBadge({ caps }) {
  const features = [
    caps.hasSkins && 'rigged',
    caps.availableClips.size > 0 && `${caps.availableClips.size} clips`,
    caps.hasVisemes && 'visemes',
    caps.hasBlinkShapes && 'blinks',
    caps.hasEyeLook && 'eye-tracking',
    caps.hasBrowShapes && 'expressions',
    caps.skeletonHint !== 'unknown' && caps.skeletonHint
  ].filter(Boolean);
  if (features.length === 0) return null;
  return (
    <div className="absolute bottom-4 left-4 px-3 py-1.5 rounded-md bg-port-card/80 backdrop-blur border border-port-border text-xs text-gray-400 font-mono">
      {features.join(' · ')}
    </div>
  );
}
