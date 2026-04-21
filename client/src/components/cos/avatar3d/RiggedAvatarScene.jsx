import { useRef, useEffect } from 'react';
import { useGLTF } from '@react-three/drei';
import { useAvatarCapabilities } from './useAvatarCapabilities';
import { useStateAnimation } from './useStateAnimation';
import { useExpressionLayer } from './useExpressionLayer';
import { useLifeLayer } from './useLifeLayer';
import { useSpeakingLayer } from './useSpeakingLayer';

// Inner scene: the rigged character primitive plus all four runtime layers.
// Lives inside a Canvas — not a top-level component. Height/camera/lighting
// are owned by the wrapper (Rigged3DCoSAvatar for header, Rigged3DStage for
// the full page).
export default function RiggedAvatarScene({ url, state, speaking, onCapabilitiesReady }) {
  const gltf = useGLTF(url);
  const capabilities = useAvatarCapabilities(gltf);
  const rootRef = useRef();

  useEffect(() => {
    if (onCapabilitiesReady) onCapabilitiesReady(capabilities);
  }, [capabilities, onCapabilitiesReady]);

  useStateAnimation({ gltf, capabilities, state });
  useExpressionLayer({ gltf, capabilities, state });
  useLifeLayer({ gltf, capabilities, state, rootRef });
  useSpeakingLayer({ gltf, capabilities, speaking });

  return (
    <primitive ref={rootRef} object={gltf.scene} />
  );
}
