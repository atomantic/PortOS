import * as THREE from 'three';

// Normalize a loaded model to a fixed on-screen height so different source GLBs
// (authored at wildly different scales) frame identically.
//
// The two vertical anchorings the avatars need are made explicit rather than
// left implicit per consumer:
//   feetOnGround: false → the model's bounding-box CENTER lands at `yOffset`
//                         (a bust/portrait framing — the Cyber Muse avatar).
//   feetOnGround: true  → the model's LOWEST point lands at `yOffset`
//                         (a standing figure on a ground plane / shadow disc).
// `x`/`z` are always recentered on the bounding-box center.
//
// Call this from an effect, never during render: the bounding box is only
// correct after `useAnimations` has bound the skeleton/mixer — measuring a
// skinned mesh during render sees an unposed rig and yields a wildly wrong size.
//
// The transform is absolute, and the object is reset to identity before
// measuring, so repeat calls on the same object converge on the same result
// (StrictMode runs mount effects twice; without the reset the second pass would
// measure an already-fitted model, compute scale ≈ 1, and blow it back up to
// source size). GLTFLoader's scene root is a plain identity-transform Group, so
// resetting it discards nothing the model authored.
export function fitModelToHeight(object, { targetHeight, feetOnGround = false, yOffset = 0 } = {}) {
  object.scale.setScalar(1);
  object.position.set(0, 0, 0);
  object.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(object);
  // An object carrying no renderable geometry measures as an EMPTY box, whose
  // `min` is +Infinity — fitting it would fling the object to -Infinity and
  // take any sibling content in the group with it. Leave it at identity.
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
