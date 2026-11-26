// Frames a perspective camera around its scene group, an isolated object or an explicit world-space box.
import { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box3, Vector3 } from 'three';

const BoundsContext = createContext(null);
export function useBounds() {
  return useContext(BoundsContext);
}

export function Bounds({ fit, clip, observe, margin = 1.2, children }) {
  const { camera, controls, size, invalidate } = useThree();
  const group = useRef(null);
  const motion = useRef(null);
  const api = useMemo(() => {
    const box = new Box3();
    const center = new Vector3();
    let distance;
    return {
      refresh(object = group.current) {
        motion.current = null;
        if (object?.isBox3) box.copy(object);
        else if (object) {
          object.updateWorldMatrix(true, true);
          box.setFromObject(object);
        }
        const extent = box.getSize(new Vector3());
        const width = Math.max(extent.x, extent.y, extent.z) || camera.position.length() || 10;
        box.getCenter(center);
        distance = margin * width / (2 * Math.atan(camera.fov * Math.PI / 360)) / Math.min(camera.aspect, 1);
        return this;
      },
      clip() {
        camera.near = distance / 100;
        camera.far = distance * 100;
        camera.updateProjectionMatrix();
        if (controls) controls.maxDistance = distance * 10;
        invalidate();
        return this;
      },
      fit() {
        const direction = camera.position.clone().sub(center);
        if (!direction.lengthSq()) direction.set(0, 0, 1);
        motion.current = {
          elapsed: 0,
          from: camera.position.clone(),
          to: center.clone().addScaledVector(direction.normalize(), distance),
          fromTarget: controls?.target.clone() || camera.getWorldDirection(new Vector3()).multiplyScalar(distance).add(camera.position),
          toTarget: center.clone(),
          target: new Vector3(),
        };
        invalidate();
        return this;
      },
    };
  }, [camera, controls, invalidate, margin]);

  // Observe resize only when requested. A new camera or controls still needs
  // its own clip planes and target, including Strict Mode remounts.
  const observedWidth = observe ? size.width : null;
  const observedHeight = observe ? size.height : null;
  useLayoutEffect(() => {
    api.refresh();
    if (clip) api.clip();
    if (fit) api.fit();
  }, [api, clip, fit, observedWidth, observedHeight]);
  useLayoutEffect(() => {
    const stop = () => { motion.current = null; };
    controls?.addEventListener('start', stop);
    return () => controls?.removeEventListener('start', stop);
  }, [controls]);
  useFrame((_, delta) => {
    const move = motion.current;
    if (!move) return;
    move.elapsed += Math.min(delta, 0.1);
    const progress = move.elapsed >= 1 ? 1 : 1 - Math.exp(-5 * move.elapsed) + 0.007 * move.elapsed;
    camera.position.lerpVectors(move.from, move.to, progress);
    move.target.lerpVectors(move.fromTarget, move.toTarget, progress);
    camera.lookAt(move.target);
    if (controls) {
      controls.target.copy(move.target);
      controls.update();
    }
    if (progress === 1) motion.current = null;
    invalidate();
  });
  return <group ref={group}><BoundsContext.Provider value={api}>{children}</BoundsContext.Provider></group>;
}
