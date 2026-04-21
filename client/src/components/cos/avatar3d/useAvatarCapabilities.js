import { useMemo } from 'react';
import { VISEME_KEYS } from './stateClipMap';

// Scan a loaded glTF scene for rig features. Downstream layers gate behavior
// on these booleans so a minimal rig still renders — it just animates less.
export function useAvatarCapabilities(gltf) {
  return useMemo(() => detectCapabilities(gltf), [gltf]);
}

export function detectCapabilities(gltf) {
  if (!gltf || !gltf.scene) {
    return empty();
  }

  const shapeKeys = collectShapeKeys(gltf.scene);
  const clipNames = (gltf.animations || []).map((a) => a.name);
  const boneNames = collectBoneNames(gltf.scene);

  const hasSkins = hasAnySkin(gltf.scene);
  const availableClips = new Set(clipNames);

  const hasVisemes = VISEME_KEYS.some((k) => shapeKeys.has(k));
  const hasBlinkShapes = shapeKeys.has('Eye_Blink_L') && shapeKeys.has('Eye_Blink_R');
  const hasEyeLook = ['Eye_L_Look_L', 'Eye_L_Look_R', 'Eye_R_Look_L', 'Eye_R_Look_R']
    .some((k) => shapeKeys.has(k));
  const hasBrowShapes = ['Brow_Raise_Inner_L', 'Brow_Compress_L', 'Brow_Drop_L']
    .some((k) => shapeKeys.has(k));
  const hasMouthShapes = ['Mouth_Smile_L', 'Mouth_Frown_L'].some((k) => shapeKeys.has(k));

  let skeletonHint = 'unknown';
  if (boneNames.some((n) => n.startsWith('cc_base_'))) skeletonHint = 'cc3';
  else if (boneNames.some((n) => n.startsWith('mixamorig'))) skeletonHint = 'mixamo';

  return {
    hasSkins,
    availableClips,
    clipNames,
    hasVisemes,
    hasBlinkShapes,
    hasEyeLook,
    hasBrowShapes,
    hasMouthShapes,
    shapeKeys,
    skeletonHint,
    bonesByName: collectBonesMap(gltf.scene)
  };
}

function empty() {
  return {
    hasSkins: false,
    availableClips: new Set(),
    clipNames: [],
    hasVisemes: false,
    hasBlinkShapes: false,
    hasEyeLook: false,
    hasBrowShapes: false,
    hasMouthShapes: false,
    shapeKeys: new Set(),
    skeletonHint: 'unknown',
    bonesByName: new Map()
  };
}

function collectShapeKeys(root) {
  const set = new Set();
  root.traverse((obj) => {
    if (obj.morphTargetDictionary) {
      for (const name of Object.keys(obj.morphTargetDictionary)) set.add(name);
    }
  });
  return set;
}

function collectBoneNames(root) {
  const names = [];
  root.traverse((obj) => {
    if (obj.isBone) names.push(obj.name);
  });
  return names;
}

function collectBonesMap(root) {
  const map = new Map();
  root.traverse((obj) => {
    if (obj.isBone) map.set(obj.name, obj);
  });
  return map;
}

function hasAnySkin(root) {
  let found = false;
  root.traverse((obj) => {
    if (obj.isSkinnedMesh) found = true;
  });
  return found;
}
