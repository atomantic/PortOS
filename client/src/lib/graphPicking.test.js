// @vitest-environment node

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  projectToScreen,
  pickNearestNodeByScreenDistance,
  isTapGesture,
  TOUCH_PICK_THRESHOLD_PX
} from './graphPicking.js';

const WIDTH = 800;
const HEIGHT = 400;

// A real perspective camera looking down -Z from z=80, matching BrainGraph's
// Canvas defaults. Only Matrix4 math runs here — no renderer, no WebGL.
const viewProjectionAt = (position = [0, 0, 80]) => {
  const camera = new THREE.PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 1000);
  camera.position.set(...position);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .elements;
};

const VP = viewProjectionAt();

describe('projectToScreen', () => {
  it('maps the point the camera looks at to the centre of the canvas', () => {
    const screen = projectToScreen({ x: 0, y: 0, z: 0 }, VP, WIDTH, HEIGHT);
    expect(screen.x).toBeCloseTo(WIDTH / 2, 6);
    expect(screen.y).toBeCloseTo(HEIGHT / 2, 6);
  });

  it('grows y downward, matching clientY', () => {
    const above = projectToScreen({ x: 0, y: 10, z: 0 }, VP, WIDTH, HEIGHT);
    expect(above.y).toBeLessThan(HEIGHT / 2);
  });

  it('returns null for a point behind the camera', () => {
    expect(projectToScreen({ x: 0, y: 0, z: 200 }, VP, WIDTH, HEIGHT)).toBeNull();
  });

  it('reports a nearer point with a smaller depth', () => {
    const near = projectToScreen({ x: 0, y: 0, z: 20 }, VP, WIDTH, HEIGHT);
    const far = projectToScreen({ x: 0, y: 0, z: -20 }, VP, WIDTH, HEIGHT);
    expect(near.depth).toBeLessThan(far.depth);
  });
});

describe('pickNearestNodeByScreenDistance', () => {
  // Screen position of a world point, for building tap coordinates.
  const at = (world) => projectToScreen(world, VP, WIDTH, HEIGHT);

  const pick = (nodes, point, threshold) => pickNearestNodeByScreenDistance({
    nodes, viewProjection: VP, width: WIDTH, height: HEIGHT, point, threshold
  });

  it('picks the nearest node to the tap', () => {
    const nodes = [
      { id: 'far', x: 6, y: 0, z: 0 },
      { id: 'near', x: 1, y: 0, z: 0 },
    ];
    expect(pick(nodes, at({ x: 0, y: 0, z: 0 }))?.id).toBe('near');
  });

  it('selects a node the tap misses outright, within the touch threshold', () => {
    const node = { id: 'n1', x: 0, y: 0, z: 0 };
    const centre = at(node);
    // 30px away — nowhere near the ~5px disc the raycast would have required.
    const picked = pick([node], { x: centre.x + 30, y: centre.y });
    expect(picked?.id).toBe('n1');
  });

  it('returns null when every node is outside the threshold', () => {
    const node = { id: 'n1', x: 0, y: 0, z: 0 };
    const centre = at(node);
    const picked = pick([node], { x: centre.x + TOUCH_PICK_THRESHOLD_PX + 1, y: centre.y });
    expect(picked).toBeNull();
  });

  it('breaks an exact distance tie toward the node nearer the camera', () => {
    // Same screen position (both on the camera axis), different depth.
    const nodes = [
      { id: 'behind', x: 0, y: 0, z: -20 },
      { id: 'front', x: 0, y: 0, z: 20 },
    ];
    expect(pick(nodes, at({ x: 0, y: 0, z: 0 }))?.id).toBe('front');
    // Order-independent: the depth tie-break, not array order, decides.
    expect(pick([...nodes].reverse(), at({ x: 0, y: 0, z: 0 }))?.id).toBe('front');
  });

  it('excludes nodes behind the camera even when they project onto the tap', () => {
    const nodes = [{ id: 'behind-camera', x: 0, y: 0, z: 200 }];
    expect(pick(nodes, { x: WIDTH / 2, y: HEIGHT / 2 })).toBeNull();
  });

  it('prefers an in-front node over one behind the camera at the same tap', () => {
    const nodes = [
      { id: 'behind-camera', x: 0, y: 0, z: 200 },
      { id: 'visible', x: 0, y: 0, z: 0 },
    ];
    expect(pick(nodes, { x: WIDTH / 2, y: HEIGHT / 2 })?.id).toBe('visible');
  });

  it('honours a caller-supplied threshold', () => {
    const node = { id: 'n1', x: 0, y: 0, z: 0 };
    const centre = at(node);
    const point = { x: centre.x + 20, y: centre.y };
    expect(pick([node], point, 10)).toBeNull();
    expect(pick([node], point, 40)?.id).toBe('n1');
  });

  it('returns null for empty or unusable inputs instead of throwing', () => {
    const point = { x: 0, y: 0 };
    expect(pick([], point)).toBeNull();
    expect(pick(undefined, point)).toBeNull();
    expect(pick([{ id: 'n1', x: 0, y: 0, z: 0 }], null)).toBeNull();
    expect(pickNearestNodeByScreenDistance({
      nodes: [{ id: 'n1', x: 0, y: 0, z: 0 }], viewProjection: VP, width: 0, height: 0, point
    })).toBeNull();
  });
});

describe('isTapGesture', () => {
  it('accepts a still pointer and rejects a drag', () => {
    expect(isTapGesture({ x: 100, y: 100 }, { x: 103, y: 96 })).toBe(true);
    expect(isTapGesture({ x: 100, y: 100 }, { x: 140, y: 100 })).toBe(false);
    expect(isTapGesture({ x: 100, y: 100 }, { x: 100, y: 140 })).toBe(false);
  });

  it('is false without a recorded start', () => {
    expect(isTapGesture(null, { x: 0, y: 0 })).toBe(false);
  });
});
