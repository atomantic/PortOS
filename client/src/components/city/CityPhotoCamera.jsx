import { useRef, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getPreset, stepFly } from '../../utils/cityPhotoMode';

// Photo-mode camera driver (roadmap 3.3 / 3.6). When photo mode is active this flies the camera
// to the selected cinematic preset with a smooth ease, and registers a capture function with the
// page (via `onReady`) that grabs the current WebGL frame as a PNG data URL. It renders nothing
// itself — it only mutates the shared camera and forces an on-demand render before each capture
// so `preserveDrawingBuffer` has a fresh frame to read. Mirrors CameraTransition's ease/lerp.
//
// In photo mode the Canvas runs frameloop="demand" (roadmap 3.6 animation-pause): the scene
// animates only while the camera is flying, then freezes for a clean, deliberate still. Because
// "demand" stops ticking useFrame on its own, this component pumps the loop via `invalidate()` —
// once when a fly begins (activation / preset change) and again every frame until the fly
// settles. After that nothing invalidates, so the scene holds frozen until the next fly.

export default function CityPhotoCamera({ active, presetId, onReady, composerRef }) {
  const { camera, gl, scene, invalidate } = useThree();
  const progressRef = useRef(1);
  const startPosRef = useRef(new THREE.Vector3());
  const startTargetRef = useRef(new THREE.Vector3());

  // Register the capture function with the page. Reading the canvas requires the renderer to
  // have been created with preserveDrawingBuffer:true (set on the Canvas gl prop). We force one
  // synchronous render first so the buffer matches what's on screen even when the frameloop is
  // paused ("demand") in photo mode. When the depth-of-field composer is mounted (DoF on), render
  // THROUGH it so the captured postcard carries the same bokeh as the live preview; otherwise fall
  // back to a plain renderer pass.
  useEffect(() => {
    if (!onReady) return;
    const capture = () => {
      const composer = composerRef?.current;
      if (composer) composer.render();
      else gl.render(scene, camera);
      return gl.domElement.toDataURL('image/png');
    };
    onReady(capture);
    return () => onReady(null);
  }, [onReady, gl, scene, camera, composerRef]);

  // Start a new fly whenever photo mode turns on or the preset changes. This MUST live in an
  // effect (fired on the React commit), not inside useFrame: in frameloop="demand" the loop is
  // asleep once a fly settles, so a useFrame-gated start would never run when the user cycles
  // presets on a frozen scene — the camera would stay parked on the old preset. The effect kicks
  // the demand loop via invalidate() so useFrame resumes and steps the fly to completion.
  useEffect(() => {
    if (!active) return;
    progressRef.current = 0;
    startPosRef.current.copy(camera.position);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    startTargetRef.current.copy(camera.position).add(dir.multiplyScalar(10));
    invalidate();
  }, [active, presetId, camera, invalidate]);

  useFrame((_, delta) => {
    if (!active || progressRef.current >= 1) return; // inactive, or settled — scene stays frozen

    const { progress, t, done } = stepFly(progressRef.current, delta);
    progressRef.current = progress;

    const preset = getPreset(presetId);
    const endPos = new THREE.Vector3(...preset.position);
    const endTarget = new THREE.Vector3(...preset.target);

    camera.position.lerpVectors(startPosRef.current, endPos, t);
    camera.lookAt(new THREE.Vector3().lerpVectors(startTargetRef.current, endTarget, t));

    // In frameloop="demand" the loop sleeps after this frame unless something requests another.
    // Keep pumping until the fly settles; once done, stop so the scene freezes for the shot.
    if (!done) invalidate();
  });

  return null;
}
