// Loads cached GLTFs with bundled meshopt and Draco decoders and binds animation clips to their cloned scene.
import { useEffect, useMemo } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { AnimationMixer } from 'three';
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// useLoader shares an instance across URLs, including preloads. The worker pool
// and its same-origin decoder assets are only requested by compressed models.
function configureLoader(loader) {
  if (!loader.dracoLoader) loader.setDRACOLoader(new DRACOLoader(loader.manager).setDecoderPath(DRACO_GLTF_CONFIG));
  loader.setMeshoptDecoder(MeshoptDecoder);
}

export function useGLTF(url) {
  return useLoader(GLTFLoader, url, configureLoader);
}
useGLTF.preload = url => useLoader.preload(GLTFLoader, url, configureLoader);
useGLTF.clear = url => useLoader.clear(GLTFLoader, url);

export function useAnimations(clips, root) {
  const mixer = useMemo(() => new AnimationMixer(root), [root]);
  const animation = useMemo(() => {
    const actions = Object.create(null);
    for (const clip of clips) {
      // Defer binding until requested. Strict Mode may replay uncacheRoot on
      // mount; retaining a detached action would leave the next play inert.
      Object.defineProperty(actions, clip.name, { configurable: true, enumerable: true, get: () => mixer.clipAction(clip, root) });
    }
    return { mixer, names: clips.map(clip => clip.name), actions };
  }, [clips, mixer, root]);
  useFrame((_, delta) => mixer.update(delta));
  useEffect(() => () => {
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
  }, [animation, mixer, root]);
  return animation;
}
