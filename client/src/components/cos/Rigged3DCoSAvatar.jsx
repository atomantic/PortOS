import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import RiggedAvatarScene from './avatar3d/RiggedAvatarScene';
import { useAvatarModel } from './avatar3d/useAvatarModel';
import CoSCharacter from './CoSCharacter';

// Header-slot variant of the rigged 3D avatar. Matches the footprint of the
// SVG/cyber/sigil/esoteric/nexus variants — small, fixed camera, no controls.
//
// If no model is configured on the server, falls back to the default SVG
// CoSCharacter so the header is never blank.
export default function Rigged3DCoSAvatar({ state, speaking }) {
  const { status, url } = useAvatarModel();

  if (status !== 'present') {
    return <CoSCharacter state={state} speaking={speaking} />;
  }

  return (
    <div className="relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[2/3] overflow-visible">
      <Canvas camera={{ position: [0, 1.5, 2.5], fov: 30 }} dpr={[1, 2]} shadows={false}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[2, 4, 3]} intensity={0.9} />
        <Suspense fallback={null}>
          <RiggedAvatarScene url={url} state={state} speaking={speaking} />
        </Suspense>
      </Canvas>
    </div>
  );
}
