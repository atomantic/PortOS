import { describe, expect, it } from 'vitest';
import { BLENDER_MODEL_FIXED_VIEWS, reviewFrameMeters, reviewViews } from './reviewCameras.js';

const SIZE = { x: 0.4, y: 0.2, z: 0.6 };
const byId = (views) => Object.fromEntries(views.map((view) => [view.id, view]));
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
// Where a world point lands in a view: across and up, in meters from its center.
const project = (view, point) => {
  const from = point.map((value, axis) => value - view.location[axis]);
  return [dot(from, view.right), dot(from, view.up), -dot(from, view.back)];
};

describe('review cameras', () => {
  it('looks from the named side, at one scale, with the whole declared box in frame', () => {
    const views = byId(reviewViews(SIZE));
    expect(Object.keys(views)).toEqual(Object.keys(BLENDER_MODEL_FIXED_VIEWS));
    // The front faces -Y and the camera's right is +X; the top view keeps the front at the bottom.
    expect(views.front).toMatchObject({ projection: 'ORTHO', right: [1, 0, 0], up: [0, 0, 1], back: [0, -1, 0] });
    expect(views.right).toMatchObject({ right: [0, 1, 0], back: [1, 0, 0] });
    expect(views.back.back).toEqual([0, 1, 0]);
    expect(views.left.back).toEqual([-1, 0, 0]);
    expect(views.top).toMatchObject({ right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1] });
    expect(views.bottom).toMatchObject({ right: [1, 0, 0], up: [0, -1, 0], back: [0, 0, -1] });

    const half = reviewFrameMeters(SIZE) / 2;
    for (const view of Object.values(views)) {
      expect(view.orthoScale).toBe(views.front.orthoScale);
      for (const axes of [[view.right, view.up], [view.up, view.back], [view.back, view.right]]) expect(dot(...axes)).toBeCloseTo(0, 5);
      for (const x of [-SIZE.x / 2, SIZE.x / 2]) for (const y of [-SIZE.y / 2, SIZE.y / 2]) for (const z of [0, SIZE.z]) {
        const [across, up, depth] = project(view, [x, y, z]);
        expect(Math.max(Math.abs(across), Math.abs(up))).toBeLessThan(half);
        expect(depth).toBeGreaterThan(view.clipStart);
        expect(depth).toBeLessThan(view.clipEnd);
      }
    }
  });

  it('places a saved orbit on its aim point, and renders nothing extra for a camera on a fixed view', () => {
    const orbit = { azimuth: 90, elevation: 0, distance: 0.5, lens: 85, partId: 'hinge', target: [0.1, 0, 0.3] };
    const views = reviewViews(SIZE, [{ id: 'camera-a', view: 'front', orbit: null }, { id: 'camera-b', view: null, orbit }]);
    expect(views).toHaveLength(Object.keys(BLENDER_MODEL_FIXED_VIEWS).length + 1);
    expect(views.at(-1)).toMatchObject({ id: 'camera-b', projection: 'PERSP', location: [0.6, 0, 0.3], lens: 85 });
    // No part: the middle of the declared box.
    expect(reviewViews(SIZE, [{ id: 'camera-c', orbit: { ...orbit, target: null } }]).at(-1).location).toEqual([0.5, 0, 0.3]);
  });
});
