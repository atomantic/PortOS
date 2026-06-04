import { useRef, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getPreset } from '../../utils/cityPhotoMode';
import { smoothstep } from '../../utils/easing';

// Photo-mode camera driver (roadmap 3.3). When photo mode is active this flies the camera to
// the selected cinematic preset with a smooth ease, and registers a capture function with the
// page (via `onReady`) that grabs the current WebGL frame as a PNG data URL. It renders nothing
// itself — it only mutates the shared camera and forces an on-demand render before each capture
// so `preserveDrawingBuffer` has a fresh frame to read. Mirrors CameraTransition's ease/lerp.

const FLY_DURATION = 1.1; // seconds — slower than the exploration transition for a cinematic feel

export default function CityPhotoCamera({ active, presetId, onReady }) {
  const { camera, gl, scene } = useThree();
  const progressRef = useRef(1);
  const startPosRef = useRef(new THREE.Vector3());
  const startTargetRef = useRef(new THREE.Vector3());
  const lastPresetRef = useRef(null);
  const wasActiveRef = useRef(false);

  // Register the capture function with the page. Reading the canvas requires the renderer to
  // have been created with preserveDrawingBuffer:true (set on the Canvas gl prop). We force one
  // synchronous render of the current scene/camera first so the buffer matches what's on screen
  // even when the frameloop is paused ("demand") in photo mode.
  useEffect(() => {
    if (!onReady) return;
    const capture = () => {
      gl.render(scene, camera);
      return gl.domElement.toDataURL('image/png');
    };
    onReady(capture);
    return () => onReady(null);
  }, [onReady, gl, scene, camera]);

  // Begin a fly whenever photo mode turns on or the preset changes.
  const beginFly = () => {
    progressRef.current = 0;
    startPosRef.current.copy(camera.position);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    startTargetRef.current.copy(camera.position).add(dir.multiplyScalar(10));
  };

  useFrame((_, delta) => {
    if (!active) {
      wasActiveRef.current = false;
      lastPresetRef.current = null;
      return;
    }
    // Detect activation or preset change → start a new fly from the current pose.
    if (!wasActiveRef.current || lastPresetRef.current !== presetId) {
      wasActiveRef.current = true;
      lastPresetRef.current = presetId;
      beginFly();
    }
    if (progressRef.current >= 1) return; // settled — leave the camera where the fly left it

    progressRef.current = Math.min(1, progressRef.current + delta / FLY_DURATION);
    const t = smoothstep(progressRef.current);

    const preset = getPreset(presetId);
    const endPos = new THREE.Vector3(...preset.position);
    const endTarget = new THREE.Vector3(...preset.target);

    camera.position.lerpVectors(startPosRef.current, endPos, t);
    camera.lookAt(new THREE.Vector3().lerpVectors(startTargetRef.current, endTarget, t));
  });

  return null;
}
