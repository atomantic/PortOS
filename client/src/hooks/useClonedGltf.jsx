import { useMemo } from 'react';
import { useAnimations, useGLTF } from '@react-three/drei';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

const preserveAnimations = (animations) => animations;

export function GltfPrimitive({ object, ...props }) {
  // SkeletonUtils.clone and Object3D.clone share geometry/material references
  // with drei's URL-keyed useGLTF cache. R3F must never auto-dispose those
  // shared resources on unmount, or the next mount of the URL renders blank.
  return <primitive {...props} object={object} dispose={null} />;
}

export default function useClonedGltf(url, transformAnimations = preserveAnimations) {
  const gltf = useGLTF(url);
  const scene = useMemo(() => SkeletonUtils.clone(gltf.scene), [gltf.scene]);
  const animations = useMemo(
    () => transformAnimations(gltf.animations),
    [gltf.animations, transformAnimations],
  );
  const { actions, mixer, names } = useAnimations(animations, scene);

  return { scene, animations, actions, mixer, names };
}
