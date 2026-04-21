import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

const SPEAKING_FREQ_HZ = 6;

// Speaking layer. If the model has visemes, drive V_Open + V_Lip_Open from a
// 6Hz sine while the `speaking` flag is true — visually reads as "talking"
// without needing phoneme-timed TTS metadata.
//
// If there are no visemes, fall back to a small sinusoidal head rotation
// using any head-like bone found in the rig.
export function useSpeakingLayer({ gltf, capabilities, speaking }) {
  const basisRef = useRef({ recorded: false, rotationY: 0 });

  useFrame(() => {
    if (!gltf || !gltf.scene) return;

    if (capabilities.hasVisemes) {
      const amp = speaking ? 0.5 + 0.5 * Math.sin(performance.now() / 1000 * SPEAKING_FREQ_HZ * Math.PI * 2) : 0;
      writeShape(gltf.scene, 'V_Open', amp * 0.6);
      writeShape(gltf.scene, 'V_Lip_Open', amp * 0.4);
    } else {
      const head = findHeadBone(capabilities.bonesByName);
      if (!head) return;
      if (!basisRef.current.recorded) {
        basisRef.current.recorded = true;
        basisRef.current.rotationY = head.rotation.y;
      }
      if (speaking) {
        const amp = Math.sin(performance.now() / 1000 * SPEAKING_FREQ_HZ * Math.PI * 2) * 0.08;
        head.rotation.y = basisRef.current.rotationY + amp;
      } else {
        head.rotation.y = basisRef.current.rotationY;
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

const HEAD_BONE_CANDIDATES = ['head', 'Head', 'mixamorig:Head', 'cc_base_head', 'cc_base_Head', 'neck_01', 'Neck'];
function findHeadBone(bonesByName) {
  for (const name of HEAD_BONE_CANDIDATES) {
    const bone = bonesByName.get(name);
    if (bone) return bone;
  }
  // Fallback: first bone with "head" in its name.
  for (const [name, bone] of bonesByName.entries()) {
    if (name.toLowerCase().includes('head')) return bone;
  }
  return null;
}
