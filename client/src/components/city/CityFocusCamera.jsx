import { useRef, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { smoothstep } from '../../utils/easing';
import { computeFocusCamera } from '../../utils/cityFocusCamera';

// In-canvas camera controller for CyberCity's building focus mode (issue #2593). When the
// `/city/apps/:appId` route resolves to a placed building, it flies the orbital camera (and the
// OrbitControls target) to frame that borough; when focus clears it flies back to the overview.
//
// Staleness / unmount safety: all motion runs inside useFrame, which is inherently frame-gated —
// there is NO setTimeout, so a stale deferred emit is impossible. Retargeting to a newly-selected
// building simply restarts the fly on the frame the id changes (`currentKeyRef`). The unmount
// cleanup restores OrbitControls if we were mid-fly, so navigating away can't strand the controls
// disabled.

const OVERVIEW_POS = new THREE.Vector3(0, 25, 45);
const OVERVIEW_TARGET = new THREE.Vector3(0, 0, 0);
const DURATION = 0.85; // seconds

// Approximate the camera's current look-at point from its facing (used as the fly's start target
// when OrbitControls hasn't exposed one yet).
const deriveLookAt = (camera) => {
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return camera.position.clone().add(dir.multiplyScalar(10));
};

export default function CityFocusCamera({ focusedAppId, positions, orbitRef, active = true, hudSafe }) {
  const { camera, size } = useThree();
  // `null` = overview (no fly needed on a plain /city mount). A transition into/out of focus flips
  // this and starts a fly.
  const currentKeyRef = useRef(null);
  const animRef = useRef(null);
  const controlsWasEnabledRef = useRef(true);

  useEffect(() => () => {
    // Restore controls if we unmount mid-fly (e.g. entering exploration/photo mode).
    const controls = orbitRef?.current;
    if (controls && animRef.current) controls.enabled = controlsWasEnabledRef.current;
  }, [orbitRef]);

  useFrame((_, delta) => {
    const controls = orbitRef?.current;

    const wantFocus = active && typeof focusedAppId === 'string' && focusedAppId.length > 0;
    const pos = wantFocus ? positions?.get?.(focusedAppId) : null;
    // Focus wanted but the layout position isn't ready yet → hold and retry next frame.
    if (wantFocus && !pos) return;
    const key = wantFocus ? focusedAppId : null;

    if (key !== currentKeyRef.current) {
      currentKeyRef.current = key;
      // Only capture the controls' "real" enabled state when NO fly is in progress. Retargeting
      // mid-fly (rapid building/minimap clicks, or Close before the fly settles) would otherwise
      // capture the already-disabled value and restore `false` forever.
      const wasSettled = animRef.current === null;
      const startTarget = controls?.target ? controls.target.clone() : deriveLookAt(camera);

      let endPos;
      let endTarget;
      if (key === null) {
        endPos = OVERVIEW_POS.clone();
        endTarget = OVERVIEW_TARGET.clone();
      } else {
        const aspect = size.height > 0 ? size.width / size.height : 1;
        const fovDeg = camera.isPerspectiveCamera ? camera.fov : undefined;
        const framed = computeFocusCamera({ building: pos, aspect, fovDeg, hudSafe });
        endPos = new THREE.Vector3(...framed.position);
        endTarget = new THREE.Vector3(...framed.target);
      }

      animRef.current = {
        fromPos: camera.position.clone(),
        fromTarget: startTarget,
        toPos: endPos,
        toTarget: endTarget,
        t: 0,
      };
      // Take over from OrbitControls for the duration of the fly, remembering its prior state.
      if (controls) {
        if (wasSettled) controlsWasEnabledRef.current = controls.enabled;
        controls.enabled = false;
      }
    }

    const anim = animRef.current;
    if (!anim) return; // settled — let the user orbit freely

    anim.t = Math.min(1, anim.t + delta / DURATION);
    const e = smoothstep(anim.t);
    camera.position.lerpVectors(anim.fromPos, anim.toPos, e);
    const tgt = new THREE.Vector3().lerpVectors(anim.fromTarget, anim.toTarget, e);
    if (controls) controls.target.copy(tgt);
    camera.lookAt(tgt);

    if (anim.t >= 1) {
      animRef.current = null;
      if (controls) {
        controls.enabled = controlsWasEnabledRef.current;
        controls.update?.();
      }
    }
  });

  return null;
}
