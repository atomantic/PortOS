import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

// Always-on ambient motion independent of state:
//   - periodic blink (if Eye_Blink_L/R exist)
//   - occasional saccades on the eye-look shape keys (if present)
//   - tiny breathing scale on the root so static models never feel frozen
//
// Sleeping state is a special case: blinking is suppressed so Eye_Blink stays
// at 1.0 (eyes closed) as set by the expression layer.
export function useLifeLayer({ gltf, capabilities, state, rootRef }) {
  const blinkNextRef = useRef(randomBlinkDelay());
  const blinkElapsedRef = useRef(0);
  const blinkActiveRef = useRef(false);
  const saccadeNextRef = useRef(randomSaccadeDelay());
  const saccadeElapsedRef = useRef(0);
  const saccadeTargetsRef = useRef(null);

  useFrame((_, delta) => {
    if (!gltf || !gltf.scene) return;

    // Breathing — always-on even without shape keys.
    if (rootRef?.current) {
      const breath = Math.sin(performance.now() / 1000 * 1.4) * 0.005;
      rootRef.current.scale.y = 1 + breath;
    }

    // Blinking
    if (capabilities.hasBlinkShapes && state !== 'sleeping') {
      blinkElapsedRef.current += delta;
      if (!blinkActiveRef.current && blinkElapsedRef.current >= blinkNextRef.current) {
        blinkActiveRef.current = true;
        blinkElapsedRef.current = 0;
      } else if (blinkActiveRef.current && blinkElapsedRef.current >= 0.12) {
        blinkActiveRef.current = false;
        blinkElapsedRef.current = 0;
        blinkNextRef.current = randomBlinkDelay();
      }
      const blinkValue = blinkActiveRef.current ? 1 : 0;
      writeShape(gltf.scene, 'Eye_Blink_L', blinkValue);
      writeShape(gltf.scene, 'Eye_Blink_R', blinkValue);
    }

    // Saccades
    if (capabilities.hasEyeLook) {
      saccadeElapsedRef.current += delta;
      if (saccadeElapsedRef.current >= saccadeNextRef.current) {
        saccadeTargetsRef.current = pickSaccadeTargets();
        saccadeElapsedRef.current = 0;
        saccadeNextRef.current = randomSaccadeDelay();
      }
      // Hold the current targets for ~200ms, then zero out.
      const holdTime = 0.2;
      const targets = saccadeTargetsRef.current;
      if (targets) {
        const amplitude = saccadeElapsedRef.current < holdTime ? 0.3 : 0;
        for (const key of targets) writeShape(gltf.scene, key, amplitude);
      }
    }
  });
}

function writeShape(root, name, value) {
  root.traverse((obj) => {
    if (!obj.morphTargetDictionary || !obj.morphTargetInfluences) return;
    const index = obj.morphTargetDictionary[name];
    if (index === undefined) return;
    obj.morphTargetInfluences[index] = value;
  });
}

function randomBlinkDelay() {
  return 3 + Math.random() * 2; // 3–5s
}

function randomSaccadeDelay() {
  return 2 + Math.random() * 4; // 2–6s
}

const SACCADE_PAIRS = [
  ['Eye_L_Look_L', 'Eye_R_Look_L'],
  ['Eye_L_Look_R', 'Eye_R_Look_R'],
  ['Eye_L_Look_Up', 'Eye_R_Look_Up'],
  ['Eye_L_Look_Down', 'Eye_R_Look_Down']
];
function pickSaccadeTargets() {
  return SACCADE_PAIRS[Math.floor(Math.random() * SACCADE_PAIRS.length)];
}
