import { useRef, useEffect, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { smoothstep } from '../../utils/easing';
import { computeFocusCamera, computeRegionCamera } from '../../utils/cityFocusCamera';
import { computeDistrictBounds } from '../../utils/cityMiniMap';

// In-canvas camera controller for OpenWorld's two URL-addressed camera targets: a single
// building (`/openworld/apps/:appId`, issue #2593) and a whole fast-travel region
// (`/openworld/region/:regionId`). Either one flies the orbital camera (and the OrbitControls
// target) to frame its subject; when both clear, it flies back to the overview.
//
// A building focus wins over a region when both are somehow set — the two live on separate
// routes, so that only happens transiently mid-navigation, and framing the tighter subject is
// the less jarring resolution.
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

export default function CityFocusCamera({ focusedAppId, focusedRegion, positions, orbitRef, active = true, hudSafe }) {
  const { camera, size } = useThree();
  // `null` = overview (no fly needed on a plain /openworld mount). A transition into/out of focus flips
  // this and starts a fly.
  const currentKeyRef = useRef(null);
  // The region fly's identity, built once per target change rather than inside useFrame —
  // the live loop runs ~60×/s and must not allocate a string per frame.
  const regionKey = useMemo(
    () => (focusedRegion?.anchor ? `region:${focusedRegion.id}` : null),
    [focusedRegion?.anchor, focusedRegion?.id],
  );
  // A data-driven region (downtown / the archive grid) is framed by what's actually placed,
  // not by its nominal parcel — those grids grow with the install's app count, so a fixed
  // rectangle clips the outer towers on a big install. Static regions pass null and keep the
  // parcel footprint.
  const regionBounds = useMemo(
    () => (focusedRegion?.district ? computeDistrictBounds(positions, focusedRegion.district) : null),
    [focusedRegion?.district, positions],
  );
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
    // A static region comes straight from the plan, so there is no equivalent wait — but a
    // data-driven one must wait for the layout, or the first fly frames the nominal parcel
    // and never re-flies once the real bounds arrive. `positions` present with null bounds
    // is a genuinely EMPTY district (no archived apps yet), which correctly uses the parcel.
    if (!wantFocus && active && focusedRegion?.district && !positions) return;
    const wantRegion = !wantFocus && active && regionKey !== null;
    const key = wantFocus ? focusedAppId : wantRegion ? regionKey : null;

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
        const framed = wantFocus
          ? computeFocusCamera({ building: pos, aspect, fovDeg, hudSafe })
          : computeRegionCamera({ region: focusedRegion, bounds: regionBounds, aspect, fovDeg, hudSafe });
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
