// Connects Three's orbit and map controls to the active R3F camera, event surface and frame loop.
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls as ThreeOrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MapControls as ThreeMapControls } from 'three/examples/jsm/controls/MapControls.js';

function CameraControls({ type: Type, makeDefault, ref, onChange, onStart, onEnd, enableDamping = true, ...props }) {
  const camera = useThree(state => state.camera);
  const surface = useThree(state => state.events.connected || state.gl.domElement);
  const invalidate = useThree(state => state.invalidate);
  const get = useThree(state => state.get);
  const set = useThree(state => state.set);
  const controls = useMemo(() => new Type(camera), [Type, camera]);
  useFrame(() => {
    if (controls.enabled) controls.update();
  }, -1);

  useEffect(() => {
    controls.connect(surface);
    return () => controls.dispose();
  }, [controls, surface]);
  useEffect(() => {
    const change = event => {
      invalidate();
      onChange?.(event);
    };
    controls.addEventListener('change', change);
    if (onStart) controls.addEventListener('start', onStart);
    if (onEnd) controls.addEventListener('end', onEnd);
    return () => {
      controls.removeEventListener('change', change);
      if (onStart) controls.removeEventListener('start', onStart);
      if (onEnd) controls.removeEventListener('end', onEnd);
    };
  }, [controls, invalidate, onChange, onStart, onEnd]);
  useEffect(() => {
    if (!makeDefault) return;
    const previous = get().controls;
    set({ controls });
    return () => set({ controls: previous });
  }, [controls, get, makeDefault, set]);
  return <primitive ref={ref} object={controls} enableDamping={enableDamping} {...props} />;
}

export function OrbitControls(props) {
  return <CameraControls type={ThreeOrbitControls} {...props} />;
}

export function MapControls(props) {
  return <CameraControls type={ThreeMapControls} {...props} />;
}
