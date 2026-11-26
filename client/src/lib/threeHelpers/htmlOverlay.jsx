// Projects a scene anchor into a canvas-local DOM label without re-rendering React on camera motion.
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useFrame, useThree } from '@react-three/fiber';
import { Matrix4, Vector3 } from 'three';
import { projectToScreen } from '../graphPicking.js';

export function Html({ portal, position, center, style, children }) {
  const surface = useThree(state => state.gl.domElement);
  const anchor = useRef(null);
  const root = useRef(null);
  const overlay = useRef(null);
  const [point] = useState(() => new Vector3());
  const [matrix] = useState(() => new Matrix4());
  useLayoutEffect(() => {
    const parent = portal?.current || surface.parentElement;
    const element = document.createElement('div');
    overlay.current = element;
    Object.assign(element.style, { position: 'absolute', top: '0', left: '0', display: 'none', pointerEvents: 'none' });
    parent.appendChild(element);
    const domRoot = createRoot(element);
    root.current = domRoot;
    return () => {
      root.current = null;
      overlay.current = null;
      element.remove();
      // The R3F reconciler is still committing. Release the separate DOM root
      // after it finishes so React can complete any pending label updates.
      queueMicrotask(() => domRoot.unmount());
    };
  }, [portal, surface]);
  useLayoutEffect(() => {
    root.current.render(<div style={style}>{children}</div>);
  }, [children, style, portal, surface]);
  useFrame(({ camera, size }) => {
    const element = overlay.current;
    if (!element) return;
    camera.updateWorldMatrix(true, false);
    anchor.current.getWorldPosition(point);
    matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const screen = projectToScreen(point, matrix.elements, size.width, size.height);
    element.style.display = screen && screen.depth <= 1 ? '' : 'none';
    if (screen) element.style.transform = `translate3d(${screen.x}px,${screen.y}px,0)${center ? ' translate(-50%, -50%)' : ''}`;
  });
  return <group ref={anchor} position={position} />;
}
