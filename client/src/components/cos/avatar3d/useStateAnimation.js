import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AnimationMixer, LoopRepeat } from 'three';
import { stateClipMap } from './stateClipMap';

const CROSSFADE_SECONDS = 0.3;

// Body-clip layer. Picks an AnimationClip per CoS state and crossfades
// between them via Three.js AnimationMixer. Falls back to `base` if the
// requested clip is missing.
export function useStateAnimation({ gltf, capabilities, state }) {
  const mixerRef = useRef(null);
  const currentActionRef = useRef(null);
  const clipByNameRef = useRef(new Map());

  // Build the clip lookup + mixer once per gltf.
  useEffect(() => {
    if (!gltf || !gltf.scene) return undefined;
    const mixer = new AnimationMixer(gltf.scene);
    const map = new Map();
    for (const clip of gltf.animations || []) map.set(clip.name, clip);
    mixerRef.current = mixer;
    clipByNameRef.current = map;
    currentActionRef.current = null;
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(gltf.scene);
      mixerRef.current = null;
    };
  }, [gltf]);

  // Switch clip on state change.
  useEffect(() => {
    const mixer = mixerRef.current;
    const map = clipByNameRef.current;
    if (!mixer || map.size === 0) return;

    const desired = resolveClipName(state, capabilities);
    if (!desired) return;
    const clip = map.get(desired);
    if (!clip) return;

    const next = mixer.clipAction(clip);
    next.setLoop(LoopRepeat, Infinity);
    next.enabled = true;
    next.paused = false;

    const prev = currentActionRef.current;
    if (prev === next) return;

    next.reset().fadeIn(CROSSFADE_SECONDS).play();
    if (prev) prev.fadeOut(CROSSFADE_SECONDS);
    currentActionRef.current = next;
  }, [state, capabilities]);

  useFrame((_, delta) => {
    mixerRef.current?.update(delta);
  });
}

function resolveClipName(state, capabilities) {
  const entry = stateClipMap[state] || stateClipMap.base;
  const desired = entry.clip;
  if (capabilities.availableClips.has(desired)) return desired;
  if (capabilities.availableClips.has('base')) return 'base';
  // No base clip present — return the first available clip so the mesh at
  // least moves instead of freezing in T-pose.
  return capabilities.clipNames[0] || null;
}
