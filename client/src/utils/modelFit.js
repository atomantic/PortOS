/**
 * `fitModelToHeight(object, { targetHeight, feetOnGround, yOffset })` normalizes a loaded GLB to a
 * fixed on-screen height and anchors it vertically.
 */

import * as THREE from 'three';

// Normalize a loaded model to a fixed on-screen height so GLBs authored at different scales frame identically.
// `feetOnGround: false` puts the bounding-box CENTER at `yOffset` (bust/portrait framing, the Cyber Muse avatar); `true` puts the LOWEST point there (a standing figure on a ground plane). `x`/`z` are always recentered.
//
// Call from an effect, never during render: the bounding box is only correct after `useAnimations` has bound the skeleton/mixer (an unposed rig measures wildly wrong).
// The transform is absolute and the object is reset to identity before measuring, so repeat calls converge (StrictMode runs mount effects twice; without the reset the second pass would measure an already-fitted model and blow it back up). GLTFLoader's scene root is a plain identity Group, so the reset discards nothing authored.
// `Box3.setFromObject` measures in WORLD space while `scale`/`position` are local, so the parent chain's transform is baked into the result: call this on a scene whose parent is at (or near) identity.
export function fitModelToHeight(object, { targetHeight, feetOnGround = false, yOffset = 0 }) {
  // A missing or garbage height would silently write NaN through the transform; say so and bail.
  if (!Number.isFinite(targetHeight)) {
    console.error(`❌ fitModelToHeight needs a finite targetHeight, got ${targetHeight}`);
    return;
  }

  object.scale.setScalar(1);
  object.position.set(0, 0, 0);
  object.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(object);
  // A geometry-less object measures as an EMPTY box (`min` is +Infinity), and fitting it would fling it, and its siblings, to -Infinity. Leave it at identity.
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Guard the divide so a flat (zero-height) model yields a finite scale instead
  // of Infinity, which would drop the whole object out of the scene graph.
  const scale = targetHeight / Math.max(size.y, 1e-3);

  object.scale.setScalar(scale);
  const anchorY = feetOnGround ? -box.min.y : -center.y;
  object.position.set(-center.x * scale, anchorY * scale + yOffset, -center.z * scale);
}
