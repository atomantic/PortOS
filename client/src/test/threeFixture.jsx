// Render an actual R3F scene with a CPU-only frame sink for lifecycle and world-transform tests.
import { act } from '@testing-library/react';
import { createRoot, extend } from '@react-three/fiber';
import { vi } from 'vitest';
import * as THREE from 'three';

// Node would otherwise load Fiber's CommonJS entry and a second Three instance.
// Exercise the same ESM renderer and scene constructors used by Vite.
vi.mock('@react-three/fiber', () => import('@react-three/fiber/dist/react-three-fiber.esm.js'));
extend(THREE);

export async function sceneFixture(children) {
  const canvas = document.createElement('canvas');
  const host = document.createElement('div');
  host.appendChild(canvas);
  const root = createRoot(canvas);
  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 200);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld();
  await root.configure({
    gl: { domElement: canvas, render() {}, setSize() {}, setPixelRatio() {} },
    size: { width: 400, height: 200, left: 0, top: 0 }, frameloop: 'never', camera,
  });
  let store;
  const render = async node => { await act(async () => { store = root.render(node); }); };
  await render(children);
  return {
    host, camera, state: () => store.getState(), render,
    frame: time => store.getState().advance(time),
    unmount: () => act(async () => { root.unmount(); }),
  };
}
