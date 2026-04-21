import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { stateClipMap } from './stateClipMap';

const EASE_SECONDS = 0.3;

// Expression layer: per-state facial shape-key targets, eased over time.
// No-op on models without matching shape keys.
export function useExpressionLayer({ gltf, capabilities, state }) {
  const currentRef = useRef({}); // name -> current influence value

  useFrame((_, delta) => {
    if (!gltf || !gltf.scene) return;
    if (!capabilities.hasBrowShapes && !capabilities.hasMouthShapes) return;

    const targets = (stateClipMap[state] || stateClipMap.base).expression || {};
    const current = currentRef.current;
    const lerpFactor = Math.min(1, delta / EASE_SECONDS);

    // Build set of targeted shape keys so we can ease unspecified ones back to 0.
    const targetedKeys = new Set(Object.keys(targets));

    gltf.scene.traverse((obj) => {
      if (!obj.morphTargetDictionary || !obj.morphTargetInfluences) return;
      for (const [name, index] of Object.entries(obj.morphTargetDictionary)) {
        // Leave visemes alone — they're owned by the speaking layer.
        if (name.startsWith('V_')) continue;
        // Skip blink shapes if the life layer is actively blinking — but allow
        // state-driven overrides (e.g. sleeping sets Eye_Blink to 1). Life layer
        // will write 0 on non-blink frames so state overrides read through.
        const desired = targetedKeys.has(name) ? targets[name] : 0;
        const prior = current[name] ?? obj.morphTargetInfluences[index] ?? 0;
        const next = prior + (desired - prior) * lerpFactor;
        current[name] = next;
        obj.morphTargetInfluences[index] = next;
      }
    });
  });
}
