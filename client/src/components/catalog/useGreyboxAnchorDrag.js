import { useEffect, useRef } from 'react';
import { Plane, Vector3 } from 'three';
import { useThree } from '@react-three/fiber';

/** Pointer capture keeps the drag alive outside the anchor's mesh. */
export default function useGreyboxAnchorDrag(anchor, onMove, onSelect) {
  const { controls, gl } = useThree();
  const drag = useRef(null);
  const finish = () => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.controls) active.controls.enabled = active.wasEnabled;
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
  };
  useEffect(() => {
    const canvas = gl.domElement;
    const cancel = () => finish();
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('lostpointercapture', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('blur', cancel);
      finish();
    };
  }, [gl]);
  useEffect(() => { if (!onMove) finish(); }, [onMove]);

  return {
    onPointerDown: (event) => {
      if (event.button !== 0 || event.nativeEvent?.isPrimary === false || drag.current) return;
      event.stopPropagation();
      onSelect?.(`anchors:${anchor.id}`);
      if (!onMove) return;
      const plane = new Plane(new Vector3(0, 1, 0), 0);
      const hit = event.ray.intersectPlane(plane, new Vector3());
      if (!hit) return;
      drag.current = { plane, offset: [anchor.position[0] - hit.x, anchor.position[2] - hit.z], controls, wasEnabled: controls?.enabled, target: event.target, pointerId: event.pointerId };
      if (controls) controls.enabled = false;
      event.target.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
      const active = drag.current;
      if (!active || !onMove || event.pointerId !== active.pointerId) return;
      event.stopPropagation();
      const hit = event.ray.intersectPlane(active.plane, new Vector3());
      if (!hit) return;
      const snap = (n) => Math.max(-1000, Math.min(1000, Math.round(n * 10) / 10));
      onMove(anchor.id, [snap(hit.x + active.offset[0]), anchor.position[1], snap(hit.z + active.offset[1])]);
    },
    onPointerUp: (event) => { if (drag.current?.pointerId === event.pointerId) { event.stopPropagation(); finish(); } },
  };
}
